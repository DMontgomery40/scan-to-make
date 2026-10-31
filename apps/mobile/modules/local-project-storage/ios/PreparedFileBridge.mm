#import <React/RCTBridgeModule.h>
#import "CompanionPairing.h"
#import "ArtifactFiles.h"
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <math.h>

static NSUInteger const CAP_LIMIT = 64 * 1024 * 1024;
static NSString *Context(NSDictionary *p) { return p ? [NSString stringWithFormat:@"%@|%@",p[@"baseUrl"],p[@"deviceId"]] : nil; }
static NSURL *Root(NSString *name) { NSURL *u=[[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];return [u URLByAppendingPathComponent:name isDirectory:YES]; }
static NSString *Extension(NSString *type) { return [@{@"model/3mf":@"3mf",@"text/x.gcode":@"gcode"} objectForKey:type]; }
static NSURL *FileURL(NSDictionary *f) {
  if(![f isKindOfClass:NSDictionary.class])return nil;
  NSString *hash=f[@"sha256"],*ext=Extension(f[@"mediaType"]);
  if(![hash isKindOfClass:NSString.class]||![[NSPredicate predicateWithFormat:@"SELF MATCHES %@",@"[a-f0-9]{64}"] evaluateWithObject:hash]||!ext)return nil;
  return [Root(@"PreparedFiles") URLByAppendingPathComponent:[NSString stringWithFormat:@"%@.%@",hash,ext]];
}
static NSData *Verified(NSDictionary *f) {
  if(![f isKindOfClass:NSDictionary.class])return nil;
  NSURL *u=FileURL(f);NSNumber *n=f[@"byteLength"];if(!u||![n isKindOfClass:NSNumber.class]||n.doubleValue<1||n.doubleValue>CAP_LIMIT||n.doubleValue!=n.unsignedIntegerValue)return nil;
  int fd=open(u.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW);if(fd<0)return nil;
  NSMutableData *d=[NSMutableData dataWithLength:n.unsignedIntegerValue];NSUInteger off=0;while(off<d.length){ssize_t got=read(fd,(char*)d.mutableBytes+off,d.length-off);if(got<=0){close(fd);return nil;}off+=got;}char extra;ssize_t tail=read(fd,&extra,1);close(fd);return tail==0&&[STMHash(d) isEqual:f[@"sha256"]]?d:nil;
}
static BOOL Matches(NSString *value,NSString *pattern) { return [value isKindOfClass:NSString.class]&&[[NSPredicate predicateWithFormat:@"SELF MATCHES %@",pattern] evaluateWithObject:value]; }
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
@interface PreparedFileBridge : NSObject<RCTBridgeModule,NSURLSessionDataDelegate>
@property NSURLSession *session;
@property NSURLSessionDataTask *task;
@property NSMutableData *received;
@property NSDictionary *pairing;
@property NSDictionary *artifact;
@property NSHTTPURLResponse *response;
@property NSUInteger limit;
@property(copy) RCTPromiseResolveBlock resolve;
@property(copy) RCTPromiseRejectBlock reject;
@end
@implementation PreparedFileBridge
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup{return NO;}
- (dispatch_queue_t)methodQueue{return dispatch_get_main_queue();}
- (instancetype)init{if((self=[super init]))[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(changed:) name:STMPairingChanged object:nil];return self;}
- (void)dealloc{[[NSNotificationCenter defaultCenter] removeObserver:self];}
- (void)changed:(NSNotification*)n{[self fail:@"pairing-changed" message:@"Companion connection changed."];}
- (void)fail:(NSString*)code message:(NSString*)message{RCTPromiseRejectBlock reject=self.reject;self.resolve=nil;self.reject=nil;[self.task cancel];self.task=nil;[self.session invalidateAndCancel];self.session=nil;self.received=nil;if(reject)reject(code,message,nil);}
RCT_REMAP_METHOD(context,contextResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){NSError *e=nil;NSDictionary *p=STMReadPairing(&e);if(e||!p||[p[@"expiresAt"] doubleValue]<=NSDate.date.timeIntervalSince1970*1000){reject(@"pairing-required",@"Connect to your companion with a prepared file invitation.",e);return;}resolve(Context(p));}
RCT_REMAP_METHOD(request,requestOptions:(NSDictionary*)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  if(self.task){reject(@"busy",@"A prepared file request is already running.",nil);return;}
  NSError *e=nil;NSDictionary *p=STMReadPairing(&e);NSURL *base=p?STMCompanionBaseURL(p[@"baseUrl"]):nil;
  if(e||!base||![Context(p) isEqual:o[@"context"]]||[p[@"expiresAt"] doubleValue]<=NSDate.date.timeIntervalSince1970*1000){reject(@"pairing-required",@"Connect to your companion again.",e);return;}
  NSString *path=o[@"path"],*method=o[@"method"];
  NSString *jobId=@"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  NSString *prefix=[NSString stringWithFormat:@"^/v1/saved-projects/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/prepared-jobs/%@",jobId];
  NSString *revision=@"\\?projectRevision=(0|[1-9][0-9]*)$";
  NSString *pattern=[NSString stringWithFormat:@"%@(/artifacts/printable|/intent|/attempt)?%@",prefix,revision];
  NSString *productionPattern=[NSString stringWithFormat:@"%@/production\\?projectRevision=(0|[1-9][0-9]*)(&allowSupports=1)?$",prefix];
  NSString *collectionPattern=@"^/v1/saved-projects/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/prepared-jobs\\?projectRevision=(0|[1-9][0-9]*)(?:&limit=(?:[1-9]|[1-4][0-9]|50))?(?:&productionVersion=1)?(?:&cursor=[A-Za-z0-9_-]{1,1024})?$";
  BOOL listing=Matches(path,collectionPattern);
  BOOL production=Matches(path,productionPattern);
  BOOL download=[path isKindOfClass:NSString.class]&&[path containsString:@"/artifacts/printable?"];
  BOOL intent=[path isKindOfClass:NSString.class]&&[path containsString:@"/intent?"];
  BOOL attempt=[path isKindOfClass:NSString.class]&&[path containsString:@"/attempt?"];
  BOOL validMethod=[method isKindOfClass:NSString.class]&&([method isEqual:@"GET"]||[method isEqual:@"POST"]);
  BOOL shape=validMethod&&(listing||production||Matches(path,pattern))&&[o[@"etag"] isKindOfClass:NSString.class]&&Matches(o[@"etag"],@"\"[a-f0-9]{64}\"")&&!o[@"create"]&&(
    (listing&&[method isEqual:@"GET"]&&!o[@"artifact"]&&!o[@"source"]&&!o[@"body"])||
    (download&&[method isEqual:@"GET"]&&o[@"artifact"]!=nil&&!o[@"source"]&&!o[@"body"])||
    (production&&[method isEqual:@"GET"]&&!o[@"artifact"]&&!o[@"source"]&&!o[@"body"])||
    (production&&[method isEqual:@"POST"]&&o[@"source"]!=nil&&!o[@"artifact"]&&!o[@"body"])||
    (attempt&&[method isEqual:@"GET"]&&!o[@"artifact"]&&!o[@"source"]&&!o[@"body"])||
    (intent&&[method isEqual:@"POST"]&&[o[@"body"] isKindOfClass:NSString.class]&&!o[@"source"]&&!o[@"artifact"])||
    (!listing&&!download&&!production&&!intent&&!attempt&&[method isEqual:@"GET"]&&!o[@"artifact"]&&!o[@"source"]&&!o[@"body"]));
  if(!shape){reject(@"invalid-request",@"Invalid prepared file request.",nil);return;}
  NSString *scope=intent?@"prints:approve":(production&&[method isEqual:@"POST"])?@"prepared-jobs:prepare":@"prepared-jobs:read";
  if(![p[@"scopes"] containsObject:scope]){reject(@"scope-denied",intent?@"Connect with permission to approve prints.":@"Connect with permission to read inspected files.",nil);return;}
  NSData *body=nil;NSString *contentType=nil;
  if(o[@"source"]){
    NSDictionary *source=o[@"source"];
    if(![source isKindOfClass:NSDictionary.class]||source.count!=3||![source[@"mediaType"] isEqual:@"model/stl"]||![source[@"sha256"] isKindOfClass:NSString.class]||!Matches(source[@"sha256"],@"[a-f0-9]{64}")||![source[@"byteLength"] isKindOfClass:NSNumber.class]){reject(@"invalid-source",@"The accepted design file is unavailable.",nil);return;}
    // Accepted design bytes live in the shared artifact cache, keyed by digest.
    body=STMVerifiedArtifact(source[@"sha256"],source[@"byteLength"],nil);
    if(!body){reject(@"invalid-source",@"The accepted design file is unavailable.",nil);return;}
    contentType=@"model/stl";
  }
  if(intent){
    body=[o[@"body"] dataUsingEncoding:NSUTF8StringEncoding];if(!body||body.length<1||body.length>4096){reject(@"payload-too-large",@"Approval request is too large.",nil);return;}
    contentType=@"application/json";
  }
  NSMutableURLRequest *req=[NSMutableURLRequest requestWithURL:[NSURL URLWithString:path relativeToURL:base].absoluteURL];req.HTTPMethod=method;req.HTTPBody=body;
  if(body)[req setValue:contentType forHTTPHeaderField:@"Content-Type"];
  [req setValue:[@"Bearer " stringByAppendingString:p[@"token"]] forHTTPHeaderField:@"Authorization"];[req setValue:p[@"deviceId"] forHTTPHeaderField:@"X-Scan-Device"];
  [req setValue:o[@"etag"] forHTTPHeaderField:@"If-Match"];
  self.artifact=o[@"artifact"];if(self.artifact&&![self.artifact isKindOfClass:NSDictionary.class]){reject(@"invalid-artifact",@"Invalid prepared file identity.",nil);return;}self.limit=self.artifact?MIN(CAP_LIMIT,[self.artifact[@"byteLength"] unsignedIntegerValue]):(listing?64*1024:1024*1024);
  if(self.artifact&&(!FileURL(self.artifact)||self.artifact.count!=3||![self.artifact[@"byteLength"] isKindOfClass:NSNumber.class]||[self.artifact[@"byteLength"] doubleValue]!=[self.artifact[@"byteLength"] unsignedIntegerValue]||self.limit<1||[self.artifact[@"byteLength"] unsignedIntegerValue]>CAP_LIMIT)){reject(@"invalid-artifact",@"Invalid prepared file identity.",nil);return;}
  NSURLSessionConfiguration *config=NSURLSessionConfiguration.ephemeralSessionConfiguration;config.URLCache=nil;config.HTTPShouldSetCookies=NO;config.timeoutIntervalForRequest=90;config.timeoutIntervalForResource=95;
  self.pairing=p;self.resolve=resolve;self.reject=reject;self.received=[NSMutableData new];self.response=nil;
  self.session=[NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:NSOperationQueue.mainQueue];self.task=[self.session dataTaskWithRequest:req];[self.task resume];
}
- (void)URLSession:(NSURLSession*)s task:(NSURLSessionTask*)t willPerformHTTPRedirection:(NSHTTPURLResponse*)r newRequest:(NSURLRequest*)q completionHandler:(void(^)(NSURLRequest*))done{done(nil);}
- (void)URLSession:(NSURLSession*)s dataTask:(NSURLSessionDataTask*)t didReceiveResponse:(NSURLResponse*)r completionHandler:(void(^)(NSURLSessionResponseDisposition))done{
  if(t!=self.task){done(NSURLSessionResponseCancel);return;}self.response=(NSHTTPURLResponse*)r;
  if(self.response.statusCode!=200&&self.response.statusCode!=201&&self.response.statusCode!=202)self.limit=64*1024;
  if(r.expectedContentLength>(long long)self.limit){done(NSURLSessionResponseCancel);[self fail:@"payload-too-large" message:@"Prepared file response exceeded its limit."];return;}done(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession*)s dataTask:(NSURLSessionDataTask*)t didReceiveData:(NSData*)d{if(t!=self.task)return;if(d.length>self.limit-self.received.length){[self fail:@"payload-too-large" message:@"Prepared file response exceeded its limit."];return;}[self.received appendData:d];}
- (void)URLSession:(NSURLSession*)s task:(NSURLSessionTask*)t didCompleteWithError:(NSError*)e{
  if(t!=self.task)return;if(e){[self fail:STMTransportError(e) message:@"The companion response was interrupted."];return;}
  NSError *pe=nil;NSDictionary *p=STMReadPairing(&pe);if(pe||![p isEqual:self.pairing]){[self fail:@"pairing-changed" message:@"Companion connection changed."];return;}
  NSInteger status=self.response.statusCode;NSMutableDictionary *result=[@{@"status":@(status),@"etag":[self.response valueForHTTPHeaderField:@"ETag"]?:@"",@"body":@""} mutableCopy];
  if(self.artifact&&status==200){
    if(![[self.response valueForHTTPHeaderField:@"X-Content-SHA256"] isEqual:self.artifact[@"sha256"]]||![[self.response valueForHTTPHeaderField:@"Content-Type"] isEqual:self.artifact[@"mediaType"]]||self.response.expectedContentLength!=[self.artifact[@"byteLength"] longLongValue]||!Cache(self.received,self.artifact)){[self fail:@"verification-failed" message:@"Prepared file bytes could not be verified."];return;}result[@"file"]=self.artifact;
  }else{NSString *body=[[NSString alloc] initWithData:self.received encoding:NSUTF8StringEncoding];if(!body){[self fail:@"invalid-response" message:@"Companion response was unreadable."];return;}result[@"body"]=body;}
  RCTPromiseResolveBlock resolve=self.resolve;self.resolve=nil;self.reject=nil;self.task=nil;self.received=nil;[self.session finishTasksAndInvalidate];self.session=nil;resolve(result);
}
RCT_REMAP_METHOD(cancel,cancelResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){[self fail:@"cancelled" message:@"Prepared file request cancelled."];resolve(nil);}
RCT_REMAP_METHOD(hash,hashText:(NSString*)text resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSData *data=[text dataUsingEncoding:NSUTF8StringEncoding];if(!data||data.length>1024*1024){reject(@"payload-too-large",@"Prepared metadata is too large.",nil);return;}resolve(STMHash(data));
}
RCT_REMAP_METHOD(export,exportFile:(NSDictionary*)file resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSData *data=Verified(file);if(!data){reject(@"verification-failed",@"The inspected file could not be verified.",nil);return;}
  NSURL *documents=[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
  NSURL *url=[documents URLByAppendingPathComponent:[@"Imported-sliced-" stringByAppendingString:FileURL(file).lastPathComponent]];
  if(!DurableWrite(data,url)){reject(@"export-error",@"The inspected file could not be saved.",nil);return;}
  resolve(@{@"sha256":file[@"sha256"],@"byteLength":file[@"byteLength"],@"path":url.path});
}
- (void)invalidate{dispatch_async(dispatch_get_main_queue(),^{[self fail:@"cancelled" message:@"Prepared file request stopped."];});}
@end
