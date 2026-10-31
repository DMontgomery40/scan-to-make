#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <QuickLook/QuickLook.h>
#import <SceneKit/SceneKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import "CompanionPairing.h"
#import "ContentHash.h"
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <math.h>

static NSUInteger const CAP_LIMIT = 64 * 1024 * 1024;
static NSString *Context(NSDictionary *p) { return p ? [NSString stringWithFormat:@"%@|%@",p[@"baseUrl"],p[@"deviceId"]] : nil; }
static NSURL *Root(NSString *name) { NSURL *u=[[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];return [u URLByAppendingPathComponent:name isDirectory:YES]; }
static NSString *Extension(NSString *type) { return [@{@"model/vnd.usdz+zip":@"usdz",@"model/obj":@"obj",@"application/json":@"json"} objectForKey:type]; }
static NSURL *FileURL(NSDictionary *f) {
  NSString *hash=f[@"sha256"],*ext=Extension(f[@"mediaType"]);
  if(![hash isKindOfClass:NSString.class]||![[NSPredicate predicateWithFormat:@"SELF MATCHES %@",@"[a-f0-9]{64}"] evaluateWithObject:hash]||!ext)return nil;
  return [Root(@"RetainedCaptureFiles") URLByAppendingPathComponent:[NSString stringWithFormat:@"%@.%@",hash,ext]];
}
static NSData *Verified(NSDictionary *f) {
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
// Read a fixed child through an already-open, non-symlink parent. No caller paths.
static NSData *NativeReadAt(int parent, const char *name, NSUInteger limit) {
  int fd=openat(parent,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);if(fd<0)return nil;
  struct stat st;
  if(fstat(fd,&st)!=0||!S_ISREG(st.st_mode)||st.st_size<1||(unsigned long long)st.st_size>limit){close(fd);return nil;}
  NSMutableData *bytes=[NSMutableData dataWithLength:(NSUInteger)st.st_size];NSUInteger offset=0;
  while(offset<bytes.length){ssize_t n=read(fd,(char*)bytes.mutableBytes+offset,bytes.length-offset);if(n<=0){close(fd);return nil;}offset+=n;}
  char extra;BOOL exact=read(fd,&extra,1)==0;close(fd);return exact?bytes:nil;
}
static NSDictionary *AdoptNativeCapture(NSString *runID) {
  if(![runID isKindOfClass:NSString.class]||![[NSPredicate predicateWithFormat:@"SELF MATCHES %@",@"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"] evaluateWithObject:runID])return nil;
  NSURL *documents=[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
  int documentsFD=open(documents.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(documentsFD<0)return nil;
  int root=openat(documentsFD,"NativeCaptures",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);close(documentsFD);if(root<0)return nil;
  int run=openat(root,runID.UTF8String,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);close(root);if(run<0)return nil;
  NSData *manifest=NativeReadAt(run,"manifest.json",5*1024*1024);
  id decoded=manifest?[NSJSONSerialization JSONObjectWithData:manifest options:0 error:nil]:nil;
  NSDictionary *draft=[decoded isKindOfClass:NSDictionary.class]?decoded:nil;
  id file=draft[@"file"];NSNumber *size=[file isKindOfClass:NSDictionary.class]?file[@"byteLength"]:nil;
  BOOL valid=[draft[@"formatVersion"] isEqual:@1]&&[draft[@"runID"] isEqual:runID]&&[draft[@"status"] isEqual:@"ready"]&&
    [file isKindOfClass:NSDictionary.class]&&[file[@"mediaType"] isEqual:@"model/vnd.usdz+zip"]&&FileURL(file)!=nil&&
    [size isKindOfClass:NSNumber.class]&&CFGetTypeID((__bridge CFTypeRef)size)!=CFBooleanGetTypeID()&&
    isfinite(size.doubleValue)&&size.doubleValue>=1&&size.doubleValue<=32*1024*1024&&size.doubleValue==size.unsignedIntegerValue;
  if(!valid){close(run);return nil;}
  int models=openat(run,"Models",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);close(run);if(models<0)return nil;
  NSData *bytes=NativeReadAt(models,"model-mobile.usdz",32*1024*1024);close(models);
  if(!bytes||!Cache(bytes,file))return nil;
  return @{@"sha256":file[@"sha256"],@"byteLength":size,@"mediaType":@"model/vnd.usdz+zip"};
}
@interface RetainedCaptureBridge : NSObject<RCTBridgeModule,NSURLSessionDataDelegate,UIDocumentPickerDelegate,QLPreviewControllerDataSource>
@property NSURLSession *session;
@property NSURLSessionDataTask *task;
@property NSMutableData *received;
@property NSDictionary *pairing;
@property BOOL pinRejected;
@property NSDictionary *artifact;
@property NSHTTPURLResponse *response;
@property NSUInteger limit;
@property(copy) RCTPromiseResolveBlock resolve;
@property(copy) RCTPromiseRejectBlock reject;
@property(copy) RCTPromiseResolveBlock pickResolve;
@property(copy) RCTPromiseRejectBlock pickReject;
@property NSURL *previewURL;
@end
@implementation RetainedCaptureBridge
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup{return NO;}
- (dispatch_queue_t)methodQueue{return dispatch_get_main_queue();}
- (instancetype)init{if((self=[super init]))[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(changed:) name:STMPairingChanged object:nil];return self;}
- (void)dealloc{[[NSNotificationCenter defaultCenter] removeObserver:self];}
- (void)changed:(NSNotification*)n{[self fail:@"pairing-changed" message:@"Companion connection changed."];}
- (void)fail:(NSString*)code message:(NSString*)message{RCTPromiseRejectBlock reject=self.reject;self.resolve=nil;self.reject=nil;[self.task cancel];self.task=nil;[self.session invalidateAndCancel];self.session=nil;self.received=nil;if(reject)reject(code,message,nil);}
RCT_REMAP_METHOD(context,contextResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){NSError *e=nil;NSDictionary *p=STMReadPairing(&e);if(e||!p||[p[@"expiresAt"] doubleValue]<=NSDate.date.timeIntervalSince1970*1000){reject(@"pairing-required",@"Connect to your companion with a capture invitation.",e);return;}resolve(Context(p));}
RCT_REMAP_METHOD(read,readKey:(NSString*)key resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSURL *u=[Root(@"CaptureSync") URLByAppendingPathComponent:STMHash([key dataUsingEncoding:NSUTF8StringEncoding])];NSError *e=nil;
  if(![NSFileManager.defaultManager fileExistsAtPath:u.path]){resolve(nil);return;}
  NSDictionary *attrs=[NSFileManager.defaultManager attributesOfItemAtPath:u.path error:&e];if([attrs[NSFileSize] unsignedLongLongValue]>4*1024*1024){reject(@"storage-error",@"Capture history is too large.",nil);return;}
  NSString *s=[NSString stringWithContentsOfURL:u encoding:NSUTF8StringEncoding error:&e];if(!s){reject(@"storage-error",@"Capture history could not be read.",e);return;}resolve(s);
}
RCT_REMAP_METHOD(write,writeKey:(NSString*)key body:(NSString*)body resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSData *d=[body dataUsingEncoding:NSUTF8StringEncoding];NSError *e=nil;NSURL *root=Root(@"CaptureSync");
  if(d.length>4*1024*1024||![NSFileManager.defaultManager createDirectoryAtURL:root withIntermediateDirectories:YES attributes:nil error:&e]||!DurableWrite(d,[root URLByAppendingPathComponent:STMHash([key dataUsingEncoding:NSUTF8StringEncoding])])){reject(@"storage-error",@"Capture history could not be saved.",e);return;}resolve(nil);
}
RCT_REMAP_METHOD(request,requestOptions:(NSDictionary*)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  if(self.task){reject(@"busy",@"A capture request is already running.",nil);return;}
  NSError *e=nil;NSDictionary *p=STMReadPairing(&e);NSURL *base=p?STMPairingBaseURL(p):nil;
  if(e||!base||![Context(p) isEqual:o[@"context"]]||[p[@"expiresAt"] doubleValue]<=NSDate.date.timeIntervalSince1970*1000){reject(@"pairing-required",@"Connect to your companion again.",e);return;}
  NSString *path=o[@"path"],*method=o[@"method"];
  NSString *pattern=@"^/v1/saved-projects/[A-Za-z0-9_-]{1,128}(/captures(/[A-Za-z0-9_-]{1,128}(/artifacts/(original|derived|report))?)?\\?projectRevision=[0-9]+)?$";
  if(![path isKindOfClass:NSString.class]||![[NSPredicate predicateWithFormat:@"SELF MATCHES %@",pattern] evaluateWithObject:path]||![@[@"GET",@"PUT",@"POST"] containsObject:method]){reject(@"invalid-request",@"Invalid capture request.",nil);return;}
  NSData *body=nil;
  if([method isEqual:@"PUT"]){body=[o[@"body"] dataUsingEncoding:NSUTF8StringEncoding];if(!body||body.length>4*1024*1024){reject(@"payload-too-large",@"Project is too large.",nil);return;}}
  if([method isEqual:@"POST"]){body=Verified(o[@"source"]);if(!body||body.length>32*1024*1024){reject(@"invalid-source",@"Choose a valid USDZ file under 32 MB.",nil);return;}}
  NSMutableURLRequest *req=[NSMutableURLRequest requestWithURL:[NSURL URLWithString:path relativeToURL:base].absoluteURL];req.HTTPMethod=method;req.HTTPBody=body;
  [req setValue:[@"Bearer " stringByAppendingString:p[@"token"]] forHTTPHeaderField:@"Authorization"];[req setValue:p[@"deviceId"] forHTTPHeaderField:@"X-Scan-Device"];
  if(o[@"etag"])[req setValue:o[@"etag"] forHTTPHeaderField:@"If-Match"];if([o[@"create"] boolValue])[req setValue:@"*" forHTTPHeaderField:@"If-None-Match"];
  if(body)[req setValue:[method isEqual:@"POST"]?@"model/vnd.usdz+zip":@"application/json" forHTTPHeaderField:@"Content-Type"];
  self.artifact=o[@"artifact"];self.limit=self.artifact?MIN(CAP_LIMIT,[self.artifact[@"byteLength"] unsignedIntegerValue]):4*1024*1024;
  if(self.artifact&&(!FileURL(self.artifact)||self.limit<1||[self.artifact[@"byteLength"] unsignedIntegerValue]>CAP_LIMIT)){reject(@"invalid-artifact",@"Invalid capture identity.",nil);return;}
  NSURLSessionConfiguration *config=NSURLSessionConfiguration.ephemeralSessionConfiguration;config.URLCache=nil;config.HTTPShouldSetCookies=NO;config.timeoutIntervalForRequest=90;config.timeoutIntervalForResource=95;
  self.pairing=p;self.pinRejected=NO;self.resolve=resolve;self.reject=reject;self.received=[NSMutableData new];self.response=nil;
  self.session=[NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:NSOperationQueue.mainQueue];self.task=[self.session dataTaskWithRequest:req];[self.task resume];
}
- (void)URLSession:(NSURLSession*)s task:(NSURLSessionTask*)t willPerformHTTPRedirection:(NSHTTPURLResponse*)r newRequest:(NSURLRequest*)q completionHandler:(void(^)(NSURLRequest*))done{done(nil);}
- (void)URLSession:(NSURLSession*)s dataTask:(NSURLSessionDataTask*)t didReceiveResponse:(NSURLResponse*)r completionHandler:(void(^)(NSURLSessionResponseDisposition))done{
  if(t!=self.task){done(NSURLSessionResponseCancel);return;}self.response=(NSHTTPURLResponse*)r;
  if(self.response.statusCode!=200&&self.response.statusCode!=201)self.limit=64*1024;
  if(r.expectedContentLength>(long long)self.limit){done(NSURLSessionResponseCancel);[self fail:@"payload-too-large" message:@"Capture response exceeded its limit."];return;}done(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession*)s dataTask:(NSURLSessionDataTask*)t didReceiveData:(NSData*)d{if(t!=self.task)return;if(d.length>self.limit-self.received.length){[self fail:@"payload-too-large" message:@"Capture response exceeded its limit."];return;}[self.received appendData:d];}
- (void)URLSession:(NSURLSession*)s didReceiveChallenge:(NSURLAuthenticationChallenge*)c completionHandler:(void(^)(NSURLSessionAuthChallengeDisposition,NSURLCredential*))done{
  if(STMPinnedTrust(c,self.pairing,done))self.pinRejected=YES;
}
- (void)URLSession:(NSURLSession*)s task:(NSURLSessionTask*)t didCompleteWithError:(NSError*)e{
  if(t!=self.task)return;if(e){if(self.pinRejected){[self fail:@"certificate-changed" message:@"Your computer's companion presented a different certificate. Scan a new QR code from it."];return;}[self fail:STMTransportError(e) message:@"The companion response was interrupted."];return;}
  NSError *pe=nil;NSDictionary *p=STMReadPairing(&pe);if(pe||![p isEqual:self.pairing]){[self fail:@"pairing-changed" message:@"Companion connection changed."];return;}
  NSInteger status=self.response.statusCode;NSMutableDictionary *result=[@{@"status":@(status),@"etag":[self.response valueForHTTPHeaderField:@"ETag"]?:@"",@"body":@""} mutableCopy];
  if(self.artifact&&status==200){
    if(![[self.response valueForHTTPHeaderField:@"X-Content-SHA256"] isEqual:self.artifact[@"sha256"]]||![[self.response valueForHTTPHeaderField:@"Content-Type"] isEqual:self.artifact[@"mediaType"]]||self.response.expectedContentLength!=[self.artifact[@"byteLength"] longLongValue]||!Cache(self.received,self.artifact)){[self fail:@"verification-failed" message:@"Capture bytes could not be verified."];return;}result[@"file"]=self.artifact;
  }else{NSString *body=[[NSString alloc] initWithData:self.received encoding:NSUTF8StringEncoding];if(!body){[self fail:@"invalid-response" message:@"Companion response was unreadable."];return;}result[@"body"]=body;}
  RCTPromiseResolveBlock resolve=self.resolve;self.resolve=nil;self.reject=nil;self.task=nil;self.received=nil;[self.session finishTasksAndInvalidate];self.session=nil;resolve(result);
}
RCT_REMAP_METHOD(cancel,cancelResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){[self fail:@"cancelled" message:@"Capture request cancelled."];resolve(nil);}
RCT_REMAP_METHOD(adoptNativeOutput,adoptNativeOutput:(NSString*)runID resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSDictionary *file=AdoptNativeCapture(runID);
  if(file)resolve(file);else reject(@"invalid-source",@"This local model could not be verified for import. Its files are kept on this device; models must be no larger than 32 MB.",nil);
}
RCT_REMAP_METHOD(pick,pickResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  UIViewController *presenter=RCTPresentedViewController();if(self.pickResolve||!presenter||presenter.presentedViewController){reject(@"busy",@"Close the current sheet first.",nil);return;}
  self.pickResolve=resolve;self.pickReject=reject;UIDocumentPickerViewController *picker=[[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[[UTType typeWithFilenameExtension:@"usdz"]] asCopy:YES];picker.delegate=self;picker.allowsMultipleSelection=NO;[presenter presentViewController:picker animated:YES completion:nil];
}
- (void)documentPickerWasCancelled:(UIDocumentPickerViewController*)controller{if(self.pickReject)self.pickReject(@"cancelled",@"File selection cancelled.",nil);self.pickResolve=nil;self.pickReject=nil;}
- (void)documentPicker:(UIDocumentPickerViewController*)controller didPickDocumentsAtURLs:(NSArray<NSURL*>*)urls{
  NSURL *u=urls.firstObject;BOOL scoped=[u startAccessingSecurityScopedResource];NSError *e=nil;NSDictionary *a=[NSFileManager.defaultManager attributesOfItemAtPath:u.path error:&e];NSData *d=nil;
  if([a[NSFileType] isEqual:NSFileTypeRegular]&&[a[NSFileSize] unsignedIntegerValue]>0&&[a[NSFileSize] unsignedIntegerValue]<=32*1024*1024){
    int fd=open(u.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW);struct stat st;
    if(fd>=0&&fstat(fd,&st)==0&&S_ISREG(st.st_mode)&&st.st_size>0&&st.st_size<=32*1024*1024){
      NSMutableData *copy=[NSMutableData dataWithLength:(NSUInteger)st.st_size];NSUInteger off=0;BOOL ok=YES;
      while(off<copy.length){ssize_t got=read(fd,(char*)copy.mutableBytes+off,copy.length-off);if(got<=0){ok=NO;break;}off+=got;}
      char extra;if(ok&&read(fd,&extra,1)==0)d=copy;
    }if(fd>=0)close(fd);
  }
  if(scoped)[u stopAccessingSecurityScopedResource];NSDictionary *f=d?@{@"sha256":STMHash(d),@"byteLength":@(d.length),@"mediaType":@"model/vnd.usdz+zip"}:nil;
  if(f&&Cache(d,f)){if(self.pickResolve)self.pickResolve(f);}else if(self.pickReject)self.pickReject(@"invalid-source",@"Choose a readable USDZ file under 32 MB.",e);self.pickResolve=nil;self.pickReject=nil;
}
RCT_REMAP_METHOD(present,presentFile:(NSDictionary*)f share:(BOOL)share resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSData *d=Verified(f);UIViewController *presenter=RCTPresentedViewController();if(!d||!presenter||presenter.presentedViewController){reject(@"verification-failed",@"The capture file could not be opened.",nil);return;}
  if(share){
    NSURL *dir=[NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];NSError *e=nil;[NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:&e];NSURL *u=[dir URLByAppendingPathComponent:FileURL(f).lastPathComponent];
    if(![d writeToURL:u options:NSDataWritingWithoutOverwriting error:&e]){reject(@"export-error",@"Capture export could not be saved.",e);return;}
    UIActivityViewController *sheet=[[UIActivityViewController alloc] initWithActivityItems:@[u] applicationActivities:nil];sheet.popoverPresentationController.sourceView=presenter.view;sheet.popoverPresentationController.sourceRect=CGRectMake(CGRectGetMidX(presenter.view.bounds),CGRectGetMidY(presenter.view.bounds),1,1);
    sheet.completionWithItemsHandler=^(UIActivityType type,BOOL completed,NSArray *items,NSError *error){if(error)reject(@"export-error",@"Capture sharing failed.",error);else resolve(@{@"completed":@(completed),@"sha256":f[@"sha256"],@"byteLength":f[@"byteLength"]});};[presenter presentViewController:sheet animated:YES completion:nil];
  }else if([f[@"mediaType"] isEqual:@"model/obj"]){
    NSError *sceneError=nil;SCNScene *scene=[SCNScene sceneWithURL:FileURL(f) options:@{SCNSceneSourceCheckConsistencyKey:@YES} error:&sceneError];
    if(!scene){reject(@"preview-error",@"This mesh could not be displayed.",sceneError);return;}
    SCNVector3 low,high;
    if([scene.rootNode getBoundingBoxMin:&low max:&high]){
      float width=high.x-low.x,height=high.y-low.y,depth=high.z-low.z;
      float span=fmaxf(fmaxf(width,height),depth);float aspect=presenter.view.bounds.size.width/presenter.view.bounds.size.height;
      if(!isfinite(span)||span<=0){reject(@"preview-error",@"This mesh has no displayable bounds.",nil);return;}
      SCNNode *camera=[SCNNode node];camera.camera=[SCNCamera camera];camera.camera.usesOrthographicProjection=YES;
      camera.camera.orthographicScale=fmaxf(height,width/fmaxf(aspect,0.1f))*0.7;camera.camera.zNear=span*0.001;camera.camera.zFar=span*10;
      camera.position=SCNVector3Make((low.x+high.x)/2,(low.y+high.y)/2,high.z+span*3);[scene.rootNode addChildNode:camera];
    }
    [scene.rootNode enumerateChildNodesUsingBlock:^(SCNNode *node,BOOL *stop){if(node.geometry){SCNMaterial *material=[SCNMaterial material];material.diffuse.contents=[UIColor colorWithRed:0.55 green:0.61 blue:0.57 alpha:1];material.roughness.contents=@0.8;node.geometry.materials=@[material];}}];
    UIViewController *viewer=[UIViewController new];viewer.title=@"Capture mesh";
    SCNView *view=[[SCNView alloc] initWithFrame:presenter.view.bounds];view.autoresizingMask=UIViewAutoresizingFlexibleWidth|UIViewAutoresizingFlexibleHeight;view.scene=scene;view.allowsCameraControl=YES;view.autoenablesDefaultLighting=YES;view.backgroundColor=[UIColor colorWithRed:0.94 green:0.95 blue:0.92 alpha:1];viewer.view=view;
    viewer.navigationItem.rightBarButtonItem=[[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone target:self action:@selector(closeMesh)];
    UINavigationController *navigation=[[UINavigationController alloc] initWithRootViewController:viewer];navigation.modalPresentationStyle=UIModalPresentationFullScreen;
    [presenter presentViewController:navigation animated:YES completion:^{resolve(nil);}];
  }else{self.previewURL=FileURL(f);QLPreviewController *preview=[QLPreviewController new];preview.dataSource=self;[presenter presentViewController:preview animated:YES completion:^{resolve(nil);}];}
}
- (void)closeMesh{[RCTPresentedViewController() dismissViewControllerAnimated:YES completion:nil];}
- (NSInteger)numberOfPreviewItemsInPreviewController:(QLPreviewController*)controller{return self.previewURL?1:0;}
- (id<QLPreviewItem>)previewController:(QLPreviewController*)controller previewItemAtIndex:(NSInteger)index{return self.previewURL;}
- (void)invalidate{dispatch_async(dispatch_get_main_queue(),^{[self fail:@"cancelled" message:@"Capture request stopped."];});}
@end
