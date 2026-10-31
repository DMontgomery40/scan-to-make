#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <PhotosUI/PhotosUI.h>
#import <QuickLook/QuickLook.h>
#import <SceneKit/SceneKit.h>
#import <ModelIO/ModelIO.h>
#import <SceneKit/ModelIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <ImageIO/ImageIO.h>
#import "CompanionPairing.h"
#import "ContentHash.h"
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <math.h>

// Native transport for the detail-still and scan-processing routes. Mirrors
// RetainedCaptureBridge: pairing credentials stay
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
// Mirrors the companion's magic-byte sniffing (services/companion/src/detail-stills.ts).
static NSString *SniffMediaType(NSData *data) {
  const uint8_t *b=(const uint8_t*)data.bytes;NSUInteger n=data.length;
  if(n>=3&&b[0]==0xff&&b[1]==0xd8&&b[2]==0xff)return @"image/jpeg";
  static const uint8_t png[8]={0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a};
  if(n>=8&&memcmp(b,png,8)==0)return @"image/png";
  if(n>=12&&memcmp(b+4,"ftyp",4)==0){
    NSString *brand=[[NSString alloc] initWithBytes:b+8 length:4 encoding:NSASCIIStringEncoding];
    if(brand&&[@[@"heic",@"heix",@"heim",@"heis",@"hevc",@"hevm",@"hevs",@"mif1",@"mif2"] containsObject:brand])return @"image/heic";
  }
  return nil;
}
/** Reads one regular file without following links; reports its size even when oversized. */
static NSData *PickRead(NSURL *url,unsigned long long *size) {
  int fd=open(url.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW);if(fd<0)return nil;
  struct stat st;if(fstat(fd,&st)!=0||!S_ISREG(st.st_mode)){close(fd);return nil;}
  *size=(unsigned long long)st.st_size;
  if(*size==0||*size>STILL_LIMIT){close(fd);return nil;}
  NSMutableData *data=[NSMutableData dataWithLength:(NSUInteger)*size];NSUInteger offset=0;
  while(offset<data.length){ssize_t got=read(fd,(char*)data.mutableBytes+offset,data.length-offset);if(got<=0){close(fd);return nil;}offset+=(NSUInteger)got;}
  char extra;ssize_t tail=read(fd,&extra,1);close(fd);return tail==0?data:nil;
}
// HEIC photos are re-encoded as JPEG with ImageIO on the phone, so the
// companion never needs an HEVC decoder. Orientation and camera metadata are
// copied from the source image.
static NSData *JPEGFromHEIC(NSData *heic) {
  CGImageSourceRef source=CGImageSourceCreateWithData((__bridge CFDataRef)heic,NULL);if(!source)return nil;
  NSMutableData *jpeg=[NSMutableData data];
  CGImageDestinationRef destination=CGImageSourceGetCount(source)>0?CGImageDestinationCreateWithData((__bridge CFMutableDataRef)jpeg,(__bridge CFStringRef)UTTypeJPEG.identifier,1,NULL):NULL;
  BOOL ok=NO;
  if(destination){
    CGImageDestinationAddImageFromSource(destination,source,0,(__bridge CFDictionaryRef)@{(id)kCGImageDestinationLossyCompressionQuality:@0.92});
    ok=CGImageDestinationFinalize(destination);CFRelease(destination);
  }
  CFRelease(source);return ok&&jpeg.length?jpeg:nil;
}
/** A picked photo's identity as kept and uploaded, or a rejection reason. HEIC becomes JPEG. */
static NSDictionary *PickedStill(NSData *data,NSData **kept) {
  NSString *mediaType=SniffMediaType(data);
  if(!mediaType)return @{@"reason":@"unsupported"};
  if([mediaType isEqual:@"image/heic"]){
    data=JPEGFromHEIC(data);mediaType=@"image/jpeg";
    if(!data)return @{@"reason":@"unreadable"};
    if(data.length>STILL_LIMIT)return @{@"reason":@"too-large",@"byteLength":@(data.length)};
  }
  *kept=data;return @{@"sha256":STMHash(data),@"byteLength":@(data.length),@"mediaType":mediaType};
}
static NSString *PickTypeIdentifier(NSItemProvider *provider) {
  NSArray<UTType*> *accepted=@[UTTypeHEIC,UTTypeJPEG,UTTypePNG];
  for(NSString *identifier in provider.registeredTypeIdentifiers){
    UTType *type=[UTType typeWithIdentifier:identifier];
    for(UTType *candidate in accepted)if(type&&[type conformsToType:candidate])return identifier;
  }
  // Other formats can often be delivered as JPEG by the system.
  return [provider hasItemConformingToTypeIdentifier:UTTypeJPEG.identifier]?UTTypeJPEG.identifier:nil;
}
@interface StillsProcessingBridge : NSObject<RCTBridgeModule,NSURLSessionDataDelegate,PHPickerViewControllerDelegate,UIAdaptivePresentationControllerDelegate,QLPreviewControllerDataSource>
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
@property(copy) RCTPromiseResolveBlock pickImagesResolve;
@property BOOL pickSingle;
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
    (processingCollection&&[method isEqual:@"GET"]&&!o[@"source"]&&!o[@"artifact"]&&!o[@"body"])||
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
  if(processingCollection&&[method isEqual:@"POST"]){
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
// The system photo picker runs out of process: the app sees only the chosen
// items and needs no photo library permission. Chosen bytes are sniffed like
// the companion does, copied byte for byte into this bridge's cache where an
// upload reads them by identity, and reported with a displayable file URI.
- (void)showPicker:(NSInteger)limit presenter:(UIViewController*)presenter{
  PHPickerConfiguration *configuration=[[PHPickerConfiguration alloc] init];
  configuration.filter=[PHPickerFilter imagesFilter];
  configuration.selectionLimit=limit;
  configuration.preferredAssetRepresentationMode=PHPickerConfigurationAssetRepresentationModeCurrent;
  configuration.selection=PHPickerConfigurationSelectionOrdered;
  PHPickerViewController *picker=[[PHPickerViewController alloc] initWithConfiguration:configuration];
  picker.delegate=self;picker.presentationController.delegate=self;
  [presenter presentViewController:picker animated:YES completion:nil];
}
- (BOOL)pickerBusy:(UIViewController*)presenter{
  return self.pickResolve||self.pickImagesResolve||!presenter||presenter.presentedViewController;
}
RCT_REMAP_METHOD(pickImage,pickImageResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  UIViewController *presenter=RCTPresentedViewController();if([self pickerBusy:presenter]){reject(@"busy",@"Close the current sheet first.",nil);return;}
  self.pickSingle=YES;self.pickResolve=resolve;self.pickReject=reject;[self showPicker:1 presenter:presenter];
}
RCT_REMAP_METHOD(pickImages,pickImagesLimit:(double)limit resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSInteger count=(NSInteger)limit;
  if(count<1||count>24||(double)count!=limit){reject(@"invalid-limit",@"Choose between 1 and 24 photos.",nil);return;}
  UIViewController *presenter=RCTPresentedViewController();if([self pickerBusy:presenter]){reject(@"busy",@"Close the current sheet first.",nil);return;}
  self.pickSingle=NO;self.pickImagesResolve=resolve;self.pickReject=reject;[self showPicker:count presenter:presenter];
}
- (void)finishPhotos:(NSArray*)photos rejected:(NSArray*)rejected{
  if(self.pickSingle){
    RCTPromiseResolveBlock resolve=self.pickResolve;RCTPromiseRejectBlock reject=self.pickReject;
    self.pickResolve=nil;self.pickReject=nil;self.pickSingle=NO;
    // pickImage() predates display URIs: its callers pass the result straight
    // to an upload, whose identity check accepts exactly three fields.
    NSDictionary *first=photos.firstObject;
    if(first&&resolve)resolve(@{@"sha256":first[@"sha256"],@"byteLength":first[@"byteLength"],@"mediaType":first[@"mediaType"]});
    else if(reject)reject(rejected.count?@"invalid-source":@"cancelled",rejected.count?@"Choose a readable JPEG, HEIC or PNG photo under 25 MB.":@"Photo selection cancelled.",nil);
  }else{
    RCTPromiseResolveBlock resolve=self.pickImagesResolve;self.pickImagesResolve=nil;self.pickReject=nil;
    if(resolve)resolve(@{@"photos":photos,@"rejected":rejected});
  }
}
- (void)presentationControllerDidDismiss:(UIPresentationController*)controller{[self finishPhotos:@[] rejected:@[]];}
- (void)picker:(PHPickerViewController*)picker didFinishPicking:(NSArray<PHPickerResult*>*)results{
  [picker dismissViewControllerAnimated:YES completion:nil];
  if(!self.pickResolve&&!self.pickImagesResolve)return;
  if(results.count==0){[self finishPhotos:@[] rejected:@[]];return;}
  NSMutableArray *outcomes=[NSMutableArray arrayWithCapacity:results.count];
  for(NSUInteger i=0;i<results.count;i++)[outcomes addObject:NSNull.null];
  dispatch_group_t group=dispatch_group_create();
  dispatch_queue_t files=dispatch_queue_create("com.scantomake.stills-picker",DISPATCH_QUEUE_SERIAL);
  [results enumerateObjectsUsingBlock:^(PHPickerResult *result,NSUInteger index,BOOL *stop){
    NSString *identifier=PickTypeIdentifier(result.itemProvider);
    if(!identifier){outcomes[index]=@{@"reason":@"unsupported"};return;}
    dispatch_group_enter(group);
    [result.itemProvider loadFileRepresentationForTypeIdentifier:identifier completionHandler:^(NSURL *url,NSError *error){
      // The system removes this file when the handler returns: copy it now.
      NSDictionary *outcome=@{@"reason":@"unreadable"};
      unsigned long long size=0;NSData *data=url?PickRead(url,&size):nil;
      if(!data&&size>STILL_LIMIT){outcome=@{@"reason":@"too-large",@"byteLength":@(size)};}
      else if(data){
        NSData *kept=nil;NSDictionary *f=PickedStill(data,&kept);
        if(!kept){outcome=f;}
        else{
          __block BOOL written=NO;dispatch_sync(files,^{written=Cache(kept,f);});
          if(written)outcome=@{@"sha256":f[@"sha256"],@"byteLength":f[@"byteLength"],@"mediaType":f[@"mediaType"],@"uri":FileURL(f).absoluteString};
        }
      }
      dispatch_async(dispatch_get_main_queue(),^{outcomes[index]=outcome;dispatch_group_leave(group);});
    }];
  }];
  dispatch_group_notify(group,dispatch_get_main_queue(),^{
    NSMutableArray *photos=[NSMutableArray array];NSMutableArray *rejected=[NSMutableArray array];
    for(NSDictionary *outcome in outcomes){if(outcome[@"sha256"])[photos addObject:outcome];else[rejected addObject:outcome];}
    [self finishPhotos:photos rejected:rejected];
  });
}
RCT_REMAP_METHOD(imageUri,imageUriFile:(NSDictionary*)f resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSURL *url=FileURL(f);NSNumber *length=[f isKindOfClass:NSDictionary.class]?f[@"byteLength"]:nil;
  if(![f isKindOfClass:NSDictionary.class]||!IsStillMedia(f[@"mediaType"])||!url||![length isKindOfClass:NSNumber.class]||length.doubleValue<1||length.doubleValue>STILL_LIMIT||length.doubleValue!=length.unsignedIntegerValue){reject(@"verification-failed",@"The image could not be verified.",nil);return;}
  // A cache miss is an expected display state, not a verification failure.
  struct stat st;
  if(lstat(url.fileSystemRepresentation,&st)!=0&&errno==ENOENT){resolve(NSNull.null);return;}
  if(!Verified(f)){reject(@"verification-failed",@"The image could not be verified.",nil);return;}
  resolve(url.absoluteString);
}
RCT_REMAP_METHOD(present,presentFile:(NSDictionary*)f share:(BOOL)share resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSData *d=Verified(f);UIViewController *presenter=RCTPresentedViewController();if(!d||!presenter||presenter.presentedViewController){reject(@"verification-failed",@"The scan file could not be opened.",nil);return;}
  if(share){
    NSURL *dir=[NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];NSError *e=nil;[NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:&e];NSURL *u=[dir URLByAppendingPathComponent:FileURL(f).lastPathComponent];
    if(![d writeToURL:u options:NSDataWritingWithoutOverwriting error:&e]){reject(@"export-error",@"Scan export could not be saved.",e);return;}
    UIActivityViewController *sheet=[[UIActivityViewController alloc] initWithActivityItems:@[u] applicationActivities:nil];sheet.popoverPresentationController.sourceView=presenter.view;sheet.popoverPresentationController.sourceRect=CGRectMake(CGRectGetMidX(presenter.view.bounds),CGRectGetMidY(presenter.view.bounds),1,1);
    sheet.completionWithItemsHandler=^(UIActivityType type,BOOL completed,NSArray *items,NSError *error){if(error)reject(@"export-error",@"Scan sharing failed.",error);else resolve(@{@"completed":@(completed),@"sha256":f[@"sha256"],@"byteLength":f[@"byteLength"]});};[presenter presentViewController:sheet animated:YES completion:nil];
  }else if([f[@"mediaType"] isEqual:@"model/obj"]||[f[@"mediaType"] isEqual:@"model/stl"]){
    // Mesh viewer mirroring RetainedCaptureBridge: Quick Look cannot show OBJ/STL.
    NSError *sceneError=nil;SCNScene *scene=nil;
    if([f[@"mediaType"] isEqual:@"model/stl"]){
      MDLAsset *asset=[[MDLAsset alloc] initWithURL:FileURL(f)];
      if(asset)scene=[SCNScene sceneWithMDLAsset:asset];
    }else{
      scene=[SCNScene sceneWithURL:FileURL(f) options:@{SCNSceneSourceCheckConsistencyKey:@YES} error:&sceneError];
    }
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
    UIViewController *viewer=[UIViewController new];viewer.title=@"Scan model";
    SCNView *view=[[SCNView alloc] initWithFrame:presenter.view.bounds];view.autoresizingMask=UIViewAutoresizingFlexibleWidth|UIViewAutoresizingFlexibleHeight;view.scene=scene;view.allowsCameraControl=YES;view.autoenablesDefaultLighting=YES;view.backgroundColor=[UIColor colorWithRed:0.94 green:0.95 blue:0.92 alpha:1];viewer.view=view;
    viewer.navigationItem.rightBarButtonItem=[[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone target:self action:@selector(closeMesh)];
    UINavigationController *navigation=[[UINavigationController alloc] initWithRootViewController:viewer];navigation.modalPresentationStyle=UIModalPresentationFullScreen;
    [presenter presentViewController:navigation animated:YES completion:^{resolve(nil);}];
  }else{self.previewURL=FileURL(f);QLPreviewController *preview=[QLPreviewController new];preview.dataSource=self;[presenter presentViewController:preview animated:YES completion:^{resolve(nil);}];}
}
- (void)closeMesh{[RCTPresentedViewController() dismissViewControllerAnimated:YES completion:nil];}
- (NSInteger)numberOfPreviewItemsInPreviewController:(QLPreviewController*)controller{return self.previewURL?1:0;}
- (id<QLPreviewItem>)previewController:(QLPreviewController*)controller previewItemAtIndex:(NSInteger)index{return self.previewURL;}
- (void)invalidate{dispatch_async(dispatch_get_main_queue(),^{[self fail:@"cancelled" message:@"Scan request stopped."];});}
@end
