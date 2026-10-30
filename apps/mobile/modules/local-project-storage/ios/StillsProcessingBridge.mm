#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <QuickLook/QuickLook.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import "CompanionPairing.h"
#import "ArtifactFiles.h"
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <math.h>

// Native transport for the detail-still and scan-processing routes. Mirrors
// RetainedCaptureBridge and PreparedFileBridge: pairing credentials stay
// native, paths/methods/bodies are allowlisted, uploads send exact verified
// local bytes, and downloads are hash-verified before resolving.
static NSUInteger const CAP_LIMIT = 64 * 1024 * 1024;
static NSUInteger const STILL_LIMIT = 25 * 1024 * 1024;
static NSString *Context(NSDictionary *p) { return p ? [NSString stringWithFormat:@"%@|%@",p[@"baseUrl"],p[@"deviceId"]] : nil; }
static NSURL *Root(NSString *name) { NSURL *u=[[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];return [u URLByAppendingPathComponent:name isDirectory:YES]; }
static NSString *Extension(NSString *type) { return [@{@"image/jpeg":@"jpg",@"image/heic":@"heic",@"image/png":@"png",@"model/stl":@"stl",@"model/obj":@"obj",@"application/json":@"json"} objectForKey:type]; }
static BOOL IsStillMedia(NSString *type) { return [@[@"image/jpeg",@"image/heic",@"image/png"] containsObject:type]; }
static NSURL *FileURL(NSDictionary *f) {
  if(![f isKindOfClass:NSDictionary.class])return nil;
  NSString *hash=f[@"sha256"],*ext=Extension(f[@"mediaType"]);
  if(![hash isKindOfClass:NSString.class]||![[NSPredicate predicateWithFormat:@"SELF MATCHES %@",@"[a-f0-9]{64}"] evaluateWithObject:hash]||!ext)return nil;
  return [Root(@"ScanMediaFiles") URLByAppendingPathComponent:[NSString stringWithFormat:@"%@.%@",hash,ext]];
}
static NSData *Verified(NSDictionary *f) {
  if(![f isKindOfClass:NSDictionary.class])return nil;
  NSURL *u=FileURL(f);NSNumber *n=f[@"byteLength"];if(!u||![n isKindOfClass:NSNumber.class]||n.doubleValue<1||n.doubleValue>CAP_LIMIT||n.doubleValue!=n.unsignedIntegerValue)return nil;
  int fd=open(u.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW);if(fd<0)return nil;
  NSMutableData *d=[NSMutableData dataWithLength:n.unsignedIntegerValue];NSUInteger off=0;while(off<d.length){ssize_t got=read(fd,(char*)d.mutableBytes+off,d.length-off);if(got<=0){close(fd);return nil;}off+=got;}char extra;ssize_t tail=read(fd,&extra,1);close(fd);return tail==0&&[STMHash(d) isEqual:f[@"sha256"]]?d:nil;
}
static BOOL DurableWrite(NSData *data, NSURL *url) {
  NSFileManager *fm=NSFileManager.defaultManager;NSURL *directory=url.URLByDeletingLastPathComponent;
  if(![fm createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:nil])return NO;
  NSURL *temp=[directory URLByAppendingPathComponent:[NSUUID.UUID.UUIDString stringByAppendingString:@".tmp"]];
  int fd=open(temp.fileSystemRepresentation,O_WRONLY|O_CREAT|O_EXCL,0600);BOOL ok=fd>=0;NSUInteger off=0;
  while(ok&&off<data.length){ssize_t n=write(fd,(const char*)data.bytes+off,data.length-off);if(n<=0)ok=NO;else off+=n;}
  if(ok)ok=fsync(fd)==0;if(fd>=0)close(fd);
  if(ok)ok=rename(temp.fileSystemRepresentation,url.fileSystemRepresentation)==0;unlink(temp.fileSystemRepresentation);
  if(ok){int directoryFd=open(directory.fileSystemRepresentation,O_RDONLY);ok=directoryFd>=0&&fsync(directoryFd)==0;if(directoryFd>=0)close(directoryFd);}
  return ok;
}
static BOOL Cache(NSData *d,NSDictionary *f) {
  NSURL *u=FileURL(f);if(!u||d.length!=[f[@"byteLength"] unsignedIntegerValue]||![STMHash(d) isEqual:f[@"sha256"]])return NO;
  if(Verified(f))return YES;
  NSFileManager *fm=NSFileManager.defaultManager;NSError *e=nil;
  if(![fm createDirectoryAtURL:u.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:&e])return NO;
  // Atomic replacement only with verified bytes of this same immutable identity.
  if(!DurableWrite(d,u))return NO;
  int fd=open(u.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW);BOOL ok=fd>=0&&fsync(fd)==0;if(fd>=0)close(fd);return ok;
}
static BOOL Matches(NSString *value,NSString *pattern) { return [value isKindOfClass:NSString.class]&&[[NSPredicate predicateWithFormat:@"SELF MATCHES %@",pattern] evaluateWithObject:value]; }
static BOOL FileIdentity(NSDictionary *f,NSUInteger limit) {
  return [f isKindOfClass:NSDictionary.class]&&f.count==3&&FileURL(f)!=nil&&[f[@"byteLength"] isKindOfClass:NSNumber.class]&&[f[@"byteLength"] doubleValue]==[f[@"byteLength"] unsignedIntegerValue]&&[f[@"byteLength"] unsignedIntegerValue]>=1&&[f[@"byteLength"] unsignedIntegerValue]<=limit;
}
@interface StillsProcessingBridge : NSObject<RCTBridgeModule,NSURLSessionDataDelegate,UIDocumentPickerDelegate,QLPreviewControllerDataSource>
@property NSURLSession *session;
@property NSURLSessionDataTask *task;
@property NSMutableData *received;
@property NSDictionary *pairing;
@property NSDictionary *artifact;
@property NSHTTPURLResponse *response;
@property NSUInteger limit;
@property(copy) RCTPromiseResolveBlock resolve;
@property(copy) RCTPromiseRejectBlock reject;
@property(copy) RCTPromiseResolveBlock pickResolve;
@property(copy) RCTPromiseRejectBlock pickReject;
@property NSURL *previewURL;
@end
@implementation StillsProcessingBridge
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup{return NO;}
- (dispatch_queue_t)methodQueue{return dispatch_get_main_queue();}
- (instancetype)init{if((self=[super init]))[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(changed:) name:STMPairingChanged object:nil];return self;}
- (void)dealloc{[[NSNotificationCenter defaultCenter] removeObserver:self];}
- (void)changed:(NSNotification*)n{[self fail:@"pairing-changed" message:@"Companion connection changed."];}
- (void)fail:(NSString*)code message:(NSString*)message{RCTPromiseRejectBlock reject=self.reject;self.resolve=nil;self.reject=nil;[self.task cancel];self.task=nil;[self.session invalidateAndCancel];self.session=nil;self.received=nil;if(reject)reject(code,message,nil);}
RCT_REMAP_METHOD(context,contextResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){NSError *e=nil;NSDictionary *p=STMReadPairing(&e);if(e||!p||[p[@"expiresAt"] doubleValue]<=NSDate.date.timeIntervalSince1970*1000){reject(@"pairing-required",@"Connect to your companion with a capture invitation.",e);return;}resolve(Context(p));}
RCT_REMAP_METHOD(request,requestOptions:(NSDictionary*)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  if(self.task){reject(@"busy",@"A scan request is already running.",nil);return;}
  NSError *e=nil;NSDictionary *p=STMReadPairing(&e);NSURL *base=p?STMCompanionBaseURL(p[@"baseUrl"]):nil;
  if(e||!base||![Context(p) isEqual:o[@"context"]]||[p[@"expiresAt"] doubleValue]<=NSDate.date.timeIntervalSince1970*1000){reject(@"pairing-required",@"Connect to your companion again.",e);return;}
  NSString *path=o[@"path"],*method=o[@"method"];
  NSString *uuid=@"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  NSString *prefix=[NSString stringWithFormat:@"^/v1/saved-projects/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/captures/%@",uuid];
  NSString *revision=@"\\?projectRevision=(0|[1-9][0-9]*)$";
  BOOL stillsCollection=Matches(path,[NSString stringWithFormat:@"%@/detail-stills\\?projectRevision=(0|[1-9][0-9]*)(&label=[^&]{1,2048})?$",prefix]);
  BOOL stillItem=Matches(path,[NSString stringWithFormat:@"%@/detail-stills/%@%@",prefix,uuid,revision]);
  BOOL processingCollection=Matches(path,[NSString stringWithFormat:@"%@/scan-processing%@",prefix,revision]);
  BOOL processingJob=Matches(path,[NSString stringWithFormat:@"%@/scan-processing/%@%@",prefix,uuid,revision]);
  BOOL processingArtifact=Matches(path,[NSString stringWithFormat:@"%@/scan-processing/%@/artifacts/(repaired\\.stl|repaired\\.obj|report\\.json|pos_x\\.png|pos_y\\.png|pos_z\\.png|neg_x\\.png|neg_y\\.png|neg_z\\.png|iso_pp\\.png|iso_np\\.png|iso_nn\\.png|iso_pn\\.png)%@",prefix,uuid,revision]);
  BOOL download=stillItem||processingArtifact;
  BOOL validMethod=[method isKindOfClass:NSString.class]&&[@[@"GET",@"POST",@"DELETE"] containsObject:method];
  BOOL shape=validMethod&&[o[@"etag"] isKindOfClass:NSString.class]&&Matches(o[@"etag"],@"\"[a-f0-9]{64}\"")&&!o[@"create"]&&(
    (stillsCollection&&[method isEqual:@"GET"]&&![path containsString:@"&label="]&&!o[@"source"]&&!o[@"artifact"]&&!o[@"body"])||
    (stillsCollection&&[method isEqual:@"POST"]&&o[@"source"]!=nil&&!o[@"artifact"]&&!o[@"body"])||
    (stillItem&&[method isEqual:@"GET"]&&o[@"artifact"]!=nil&&!o[@"source"]&&!o[@"body"])||
    (stillItem&&[method isEqual:@"DELETE"]&&!o[@"source"]&&!o[@"artifact"]&&!o[@"body"])||
    (processingCollection&&[method isEqual:@"POST"]&&[o[@"body"] isKindOfClass:NSString.class]&&!o[@"source"]&&!o[@"artifact"])||
    (processingJob&&([method isEqual:@"GET"]||[method isEqual:@"DELETE"])&&!o[@"source"]&&!o[@"artifact"]&&!o[@"body"])||
    (processingArtifact&&[method isEqual:@"GET"]&&o[@"artifact"]!=nil&&!o[@"source"]&&!o[@"body"]));
  if(!shape){reject(@"invalid-request",@"Invalid scan request.",nil);return;}
  NSString *scope=[method isEqual:@"GET"]?@"captures:read":@"captures:import";
  if(![p[@"scopes"] containsObject:scope]){reject(@"scope-denied",@"Connect to your companion with a capture invitation.",nil);return;}
  NSData *body=nil;NSString *contentType=nil;
  if(o[@"source"]){
    if(!FileIdentity(o[@"source"],STILL_LIMIT)||!IsStillMedia(o[@"source"][@"mediaType"])){reject(@"invalid-source",@"Choose a valid JPEG, HEIC or PNG photo under 25 MB.",nil);return;}
    body=Verified(o[@"source"]);if(!body){reject(@"invalid-source",@"Choose a valid JPEG, HEIC or PNG photo under 25 MB.",nil);return;}
    contentType=o[@"source"][@"mediaType"];
  }
  if(processingCollection){
    body=[o[@"body"] dataUsingEncoding:NSUTF8StringEncoding];if(!body||body.length<1||body.length>4096){reject(@"payload-too-large",@"Scan request is too large.",nil);return;}
    contentType=@"application/json";
  }
  NSMutableURLRequest *req=[NSMutableURLRequest requestWithURL:[NSURL URLWithString:path relativeToURL:base].absoluteURL];req.HTTPMethod=method;req.HTTPBody=body;
  [req setValue:[@"Bearer " stringByAppendingString:p[@"token"]] forHTTPHeaderField:@"Authorization"];[req setValue:p[@"deviceId"] forHTTPHeaderField:@"X-Scan-Device"];
  [req setValue:o[@"etag"] forHTTPHeaderField:@"If-Match"];
  if(body)[req setValue:contentType forHTTPHeaderField:@"Content-Type"];
  self.artifact=download?o[@"artifact"]:nil;
  if(self.artifact){NSUInteger cap=IsStillMedia(self.artifact[@"mediaType"])?STILL_LIMIT:CAP_LIMIT;if(!FileIdentity(self.artifact,cap)){self.artifact=nil;reject(@"invalid-artifact",@"Invalid scan file identity.",nil);return;}self.limit=[self.artifact[@"byteLength"] unsignedIntegerValue];}
  else self.limit=1024*1024;
  NSURLSessionConfiguration *config=NSURLSessionConfiguration.ephemeralSessionConfiguration;config.URLCache=nil;config.HTTPShouldSetCookies=NO;config.timeoutIntervalForRequest=90;config.timeoutIntervalForResource=95;
  self.pairing=p;self.resolve=resolve;self.reject=reject;self.received=[NSMutableData new];self.response=nil;
  self.session=[NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:NSOperationQueue.mainQueue];self.task=[self.session dataTaskWithRequest:req];[self.task resume];
}
- (void)URLSession:(NSURLSession*)s task:(NSURLSessionTask*)t willPerformHTTPRedirection:(NSHTTPURLResponse*)r newRequest:(NSURLRequest*)q completionHandler:(void(^)(NSURLRequest*))done{done(nil);}
- (void)URLSession:(NSURLSession*)s dataTask:(NSURLSessionDataTask*)t didReceiveResponse:(NSURLResponse*)r completionHandler:(void(^)(NSURLSessionResponseDisposition))done{
  if(t!=self.task){done(NSURLSessionResponseCancel);return;}self.response=(NSHTTPURLResponse*)r;
  if(self.response.statusCode!=200&&self.response.statusCode!=201&&self.response.statusCode!=202)self.limit=64*1024;
  if(r.expectedContentLength>(long long)self.limit){done(NSURLSessionResponseCancel);[self fail:@"payload-too-large" message:@"Scan response exceeded its limit."];return;}done(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession*)s dataTask:(NSURLSessionDataTask*)t didReceiveData:(NSData*)d{if(t!=self.task)return;if(d.length>self.limit-self.received.length){[self fail:@"payload-too-large" message:@"Scan response exceeded its limit."];return;}[self.received appendData:d];}
- (void)URLSession:(NSURLSession*)s task:(NSURLSessionTask*)t didCompleteWithError:(NSError*)e{
  if(t!=self.task)return;if(e){[self fail:STMTransportError(e) message:@"The companion response was interrupted."];return;}
  NSError *pe=nil;NSDictionary *p=STMReadPairing(&pe);if(pe||![p isEqual:self.pairing]){[self fail:@"pairing-changed" message:@"Companion connection changed."];return;}
  NSInteger status=self.response.statusCode;NSMutableDictionary *result=[@{@"status":@(status),@"etag":[self.response valueForHTTPHeaderField:@"ETag"]?:@"",@"body":@""} mutableCopy];
  if(self.artifact&&status==200){
    if(![[self.response valueForHTTPHeaderField:@"X-Content-SHA256"] isEqual:self.artifact[@"sha256"]]||![[self.response valueForHTTPHeaderField:@"Content-Type"] isEqual:self.artifact[@"mediaType"]]||self.response.expectedContentLength!=[self.artifact[@"byteLength"] longLongValue]||!Cache(self.received,self.artifact)){[self fail:@"verification-failed" message:@"Scan bytes could not be verified."];return;}result[@"file"]=self.artifact;
  }else{NSString *body=[[NSString alloc] initWithData:self.received encoding:NSUTF8StringEncoding];if(!body){[self fail:@"invalid-response" message:@"Companion response was unreadable."];return;}result[@"body"]=body;}
  RCTPromiseResolveBlock resolve=self.resolve;self.resolve=nil;self.reject=nil;self.task=nil;self.received=nil;[self.session finishTasksAndInvalidate];self.session=nil;resolve(result);
}
RCT_REMAP_METHOD(cancel,cancelResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){[self fail:@"cancelled" message:@"Scan request cancelled."];resolve(nil);}
RCT_REMAP_METHOD(pickImage,pickImageResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  UIViewController *presenter=RCTPresentedViewController();if(self.pickResolve||!presenter||presenter.presentedViewController){reject(@"busy",@"Close the current sheet first.",nil);return;}
  self.pickResolve=resolve;self.pickReject=reject;UIDocumentPickerViewController *picker=[[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypeJPEG,UTTypePNG,UTTypeHEIC] asCopy:YES];picker.delegate=self;picker.allowsMultipleSelection=NO;[presenter presentViewController:picker animated:YES completion:nil];
}
- (void)documentPickerWasCancelled:(UIDocumentPickerViewController*)controller{if(self.pickReject)self.pickReject(@"cancelled",@"Photo selection cancelled.",nil);self.pickResolve=nil;self.pickReject=nil;}
- (void)documentPicker:(UIDocumentPickerViewController*)controller didPickDocumentsAtURLs:(NSArray<NSURL*>*)urls{
  NSURL *u=urls.firstObject;BOOL scoped=[u startAccessingSecurityScopedResource];NSError *e=nil;NSDictionary *a=[NSFileManager.defaultManager attributesOfItemAtPath:u.path error:&e];NSData *d=nil;
  NSString *ext=u.pathExtension.lowercaseString;
  NSString *mediaType=[ext isEqual:@"jpg"]||[ext isEqual:@"jpeg"]?@"image/jpeg":[ext isEqual:@"png"]?@"image/png":([ext isEqual:@"heic"]||[ext isEqual:@"heif"])?@"image/heic":nil;
  if(mediaType&&[a[NSFileType] isEqual:NSFileTypeRegular]&&[a[NSFileSize] unsignedIntegerValue]>0&&[a[NSFileSize] unsignedIntegerValue]<=STILL_LIMIT){
    int fd=open(u.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW);struct stat st;
    if(fd>=0&&fstat(fd,&st)==0&&S_ISREG(st.st_mode)&&st.st_size>0&&st.st_size<=STILL_LIMIT){
      NSMutableData *copy=[NSMutableData dataWithLength:(NSUInteger)st.st_size];NSUInteger off=0;BOOL ok=YES;
      while(off<copy.length){ssize_t got=read(fd,(char*)copy.mutableBytes+off,copy.length-off);if(got<=0){ok=NO;break;}off+=got;}
      char extra;if(ok&&read(fd,&extra,1)==0)d=copy;
    }if(fd>=0)close(fd);
  }
  if(scoped)[u stopAccessingSecurityScopedResource];NSDictionary *f=d?@{@"sha256":STMHash(d),@"byteLength":@(d.length),@"mediaType":mediaType}:nil;
  if(f&&Cache(d,f)){if(self.pickResolve)self.pickResolve(f);}else if(self.pickReject)self.pickReject(@"invalid-source",@"Choose a readable JPEG, HEIC or PNG photo under 25 MB.",e);self.pickResolve=nil;self.pickReject=nil;
}
RCT_REMAP_METHOD(present,presentFile:(NSDictionary*)f share:(BOOL)share resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSData *d=Verified(f);UIViewController *presenter=RCTPresentedViewController();if(!d||!presenter||presenter.presentedViewController){reject(@"verification-failed",@"The scan file could not be opened.",nil);return;}
  if(share){
    NSURL *dir=[NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];NSError *e=nil;[NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:&e];NSURL *u=[dir URLByAppendingPathComponent:FileURL(f).lastPathComponent];
    if(![d writeToURL:u options:NSDataWritingWithoutOverwriting error:&e]){reject(@"export-error",@"Scan export could not be saved.",e);return;}
    UIActivityViewController *sheet=[[UIActivityViewController alloc] initWithActivityItems:@[u] applicationActivities:nil];sheet.popoverPresentationController.sourceView=presenter.view;sheet.popoverPresentationController.sourceRect=CGRectMake(CGRectGetMidX(presenter.view.bounds),CGRectGetMidY(presenter.view.bounds),1,1);
    sheet.completionWithItemsHandler=^(UIActivityType type,BOOL completed,NSArray *items,NSError *error){if(error)reject(@"export-error",@"Scan sharing failed.",error);else resolve(@{@"completed":@(completed),@"sha256":f[@"sha256"],@"byteLength":f[@"byteLength"]});};[presenter presentViewController:sheet animated:YES completion:nil];
  }else{self.previewURL=FileURL(f);QLPreviewController *preview=[QLPreviewController new];preview.dataSource=self;[presenter presentViewController:preview animated:YES completion:^{resolve(nil);}];}
}
- (NSInteger)numberOfPreviewItemsInPreviewController:(QLPreviewController*)controller{return self.previewURL?1:0;}
- (id<QLPreviewItem>)previewController:(QLPreviewController*)controller previewItemAtIndex:(NSInteger)index{return self.previewURL;}
- (void)invalidate{dispatch_async(dispatch_get_main_queue(),^{[self fail:@"cancelled" message:@"Scan request stopped."];});}
@end
