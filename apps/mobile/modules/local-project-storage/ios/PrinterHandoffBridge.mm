#import <React/RCTBridgeModule.h>
#import <fcntl.h>
#import <unistd.h>
#import "CompanionPairing.h"
#import "ContentHash.h"

// Phone side of the companion's printer handoff (services/companion
// print-handoff-http.ts). The pairing credential stays native, every route
// and method is allowlisted, the `printer-handoff:use` scope is checked, and
// the model upload sends the exact cached bytes the scan check verified,
// hashed again before sending.
static NSUInteger const MODEL_LIMIT = 64 * 1024 * 1024;
static NSUInteger const PROMPT_LIMIT = 8000;
// Node rejects request headers past 16 KiB in total.
static NSUInteger const ENCODED_PROMPT_LIMIT = 12 * 1024;
static NSUInteger const ANSWER_LIMIT = 16 * 1024;
// Pending confirmations can carry a camera photo.
static NSUInteger const PENDING_LIMIT = 6 * 1024 * 1024;
static NSUInteger const RESPONSE_LIMIT = 1024 * 1024;
static NSUInteger const ERROR_LIMIT = 64 * 1024;
static NSString * const ROOT = @"/v1/printer-handoff";
static NSString * const UUID_PATTERN = @"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

static NSString *Context(NSDictionary *p) { return p ? [NSString stringWithFormat:@"%@|%@",p[@"baseUrl"],p[@"deviceId"]] : nil; }
static BOOL Matches(id value, NSString *pattern) { return [value isKindOfClass:NSString.class]&&[[NSPredicate predicateWithFormat:@"SELF MATCHES %@",pattern] evaluateWithObject:value]; }

// Reads a cleaned-up model from the content-addressed cache that scan-check
// downloads fill (StillsProcessingBridge), and returns it only if its length
// and SHA-256 still match the identity JavaScript passed.
static NSData *VerifiedModel(id f) {
  if(![f isKindOfClass:NSDictionary.class]||[f count]!=3||![f[@"mediaType"] isEqual:@"model/stl"])return nil;
  NSString *hash=f[@"sha256"];NSNumber *n=f[@"byteLength"];
  if(!Matches(hash,@"[a-f0-9]{64}")||![n isKindOfClass:NSNumber.class]||n.doubleValue<1||n.doubleValue>MODEL_LIMIT||n.doubleValue!=n.unsignedIntegerValue)return nil;
  NSURL *support=[[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];
  NSURL *u=[[support URLByAppendingPathComponent:@"ScanMediaFiles" isDirectory:YES] URLByAppendingPathComponent:[hash stringByAppendingString:@".stl"]];
  int fd=open(u.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW);if(fd<0)return nil;
  NSMutableData *d=[NSMutableData dataWithLength:n.unsignedIntegerValue];NSUInteger off=0;
  while(off<d.length){ssize_t got=read(fd,(char*)d.mutableBytes+off,d.length-off);if(got<=0){close(fd);return nil;}off+=got;}
  char extra;ssize_t tail=read(fd,&extra,1);close(fd);
  return tail==0&&[STMHash(d) isEqual:hash]?d:nil;
}

// The companion reads the request with decodeURIComponent; keep the header ASCII.
static NSString *EncodedPrompt(NSString *text) {
  NSCharacterSet *unreserved=[NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"];
  return [text stringByAddingPercentEncodingWithAllowedCharacters:unreserved];
}

@interface PrinterHandoffBridge : NSObject<RCTBridgeModule,NSURLSessionDataDelegate>
@property NSURLSession *session;
@property NSURLSessionDataTask *task;
@property NSMutableData *received;
@property NSDictionary *pairing;
@property BOOL pinRejected;
@property NSHTTPURLResponse *response;
@property NSUInteger limit;
@property NSUInteger successLimit;
@property(copy) RCTPromiseResolveBlock resolve;
@property(copy) RCTPromiseRejectBlock reject;
@end

@implementation PrinterHandoffBridge
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup{return NO;}
- (dispatch_queue_t)methodQueue{return dispatch_get_main_queue();}
- (instancetype)init{if((self=[super init]))[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(changed:) name:STMPairingChanged object:nil];return self;}
- (void)dealloc{[[NSNotificationCenter defaultCenter] removeObserver:self];}
- (void)changed:(NSNotification*)n{[self fail:@"pairing-changed" message:@"Companion connection changed."];}
- (void)fail:(NSString*)code message:(NSString*)message{RCTPromiseRejectBlock reject=self.reject;self.resolve=nil;self.reject=nil;[self.task cancel];self.task=nil;[self.session invalidateAndCancel];self.session=nil;self.received=nil;if(reject)reject(code,message,nil);}

RCT_REMAP_METHOD(context,contextResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  NSError *e=nil;NSDictionary *p=STMReadPairing(&e);
  if(e||!p||[p[@"expiresAt"] doubleValue]<=NSDate.date.timeIntervalSince1970*1000){reject(@"pairing-required",@"Connect to your companion with a printer invitation.",e);return;}
  resolve(Context(p));
}

RCT_REMAP_METHOD(request,requestOptions:(NSDictionary*)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){
  if(self.task){reject(@"busy",@"A printer request is already running.",nil);return;}
  NSError *e=nil;NSDictionary *p=STMReadPairing(&e);NSURL *base=p?STMPairingBaseURL(p):nil;
  if(e||!base||![Context(p) isEqual:o[@"context"]]||[p[@"expiresAt"] doubleValue]<=NSDate.date.timeIntervalSince1970*1000){reject(@"pairing-required",@"Connect to your companion again.",e);return;}
  id path=o[@"path"],method=o[@"method"],source=o[@"source"],body=o[@"body"],prompt=o[@"prompt"],backend=o[@"backend"];
  BOOL backends=[path isEqual:[ROOT stringByAppendingString:@"/backends"]];
  BOOL bundles=[path isEqual:[ROOT stringByAppendingString:@"/bundles"]];
  BOOL bundle=Matches(path,[NSString stringWithFormat:@"%@/bundles/%@",ROOT,UUID_PATTERN]);
  BOOL print=Matches(path,[NSString stringWithFormat:@"%@/bundles/%@/print",ROOT,UUID_PATTERN]);
  BOOL cancel=Matches(path,[NSString stringWithFormat:@"%@/bundles/%@/cancel",ROOT,UUID_PATTERN]);
  BOOL pending=[path isEqual:[ROOT stringByAppendingString:@"/elicitations"]];
  BOOL respond=Matches(path,[NSString stringWithFormat:@"%@/elicitations/%@/respond",ROOT,UUID_PATTERN]);
  BOOL get=[method isEqual:@"GET"],post=[method isEqual:@"POST"];
  BOOL bare=!source&&!body&&!prompt&&!backend;
  BOOL shape=((backends||bundles||bundle||pending)&&get&&bare)||((print||cancel)&&post&&bare)||
    (respond&&post&&[body isKindOfClass:NSString.class]&&!source&&!prompt&&!backend)||
    (bundles&&post&&source&&!body&&(!prompt||[prompt isKindOfClass:NSString.class])&&
      (!backend||[@[@"bambu-printer-mcp",@"mcp-3d-printer-server"] containsObject:backend]));
  if(!shape){reject(@"invalid-request",@"Invalid printer request.",nil);return;}
  if(![p[@"scopes"] containsObject:@"printer-handoff:use"]){reject(@"scope-denied",@"Connect to your companion with a printer invitation.",nil);return;}

  NSMutableURLRequest *req=[NSMutableURLRequest requestWithURL:[NSURL URLWithString:path relativeToURL:base].absoluteURL];req.HTTPMethod=method;
  if(bundles&&post){
    NSData *model=VerifiedModel(source);
    if(!model){reject(@"invalid-source",@"The cleaned-up model on this phone couldn’t be verified. Check your scan again.",nil);return;}
    NSString *text=prompt?:@"";NSString *encoded=EncodedPrompt(text);
    if(text.length>PROMPT_LIMIT||!encoded||encoded.length>ENCODED_PROMPT_LIMIT){reject(@"prompt-too-long",@"Your request is too long. Shorten it and try again.",nil);return;}
    req.HTTPBody=model;[req setValue:@"model/stl" forHTTPHeaderField:@"Content-Type"];
    if(encoded.length)[req setValue:encoded forHTTPHeaderField:@"X-Handoff-Prompt"];
    if(backend)[req setValue:backend forHTTPHeaderField:@"X-Handoff-Backend"];
  }else if(respond){
    NSData *d=[body dataUsingEncoding:NSUTF8StringEncoding];
    if(!d||d.length<2||d.length>ANSWER_LIMIT){reject(@"payload-too-large",@"That answer is too large.",nil);return;}
    req.HTTPBody=d;[req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  [req setValue:[@"Bearer " stringByAppendingString:p[@"token"]] forHTTPHeaderField:@"Authorization"];[req setValue:p[@"deviceId"] forHTTPHeaderField:@"X-Scan-Device"];

  NSURLSessionConfiguration *config=NSURLSessionConfiguration.ephemeralSessionConfiguration;config.URLCache=nil;config.HTTPShouldSetCookies=NO;
  // The upload is bounded by the companion's own two-minute body timeout.
  config.timeoutIntervalForRequest=bundles?125:30;config.timeoutIntervalForResource=bundles?130:35;
  // Pending questions can carry a photo, and the bundle list can be long.
  self.successLimit=(pending||(bundles&&get))?PENDING_LIMIT:RESPONSE_LIMIT;self.limit=self.successLimit;
  self.pairing=p;self.pinRejected=NO;self.resolve=resolve;self.reject=reject;self.received=[NSMutableData new];self.response=nil;
  self.session=[NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:NSOperationQueue.mainQueue];self.task=[self.session dataTaskWithRequest:req];[self.task resume];
}
- (void)URLSession:(NSURLSession*)s task:(NSURLSessionTask*)t willPerformHTTPRedirection:(NSHTTPURLResponse*)r newRequest:(NSURLRequest*)q completionHandler:(void(^)(NSURLRequest*))done{done(nil);}
- (void)URLSession:(NSURLSession*)s dataTask:(NSURLSessionDataTask*)t didReceiveResponse:(NSURLResponse*)r completionHandler:(void(^)(NSURLSessionResponseDisposition))done{
  if(t!=self.task){done(NSURLSessionResponseCancel);return;}self.response=(NSHTTPURLResponse*)r;
  NSInteger status=self.response.statusCode;self.limit=status>=200&&status<300?self.successLimit:ERROR_LIMIT;
  if(r.expectedContentLength>(long long)self.limit){done(NSURLSessionResponseCancel);[self fail:@"payload-too-large" message:@"Printer response exceeded its limit."];return;}done(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession*)s dataTask:(NSURLSessionDataTask*)t didReceiveData:(NSData*)d{if(t!=self.task)return;if(d.length>self.limit-self.received.length){[self fail:@"payload-too-large" message:@"Printer response exceeded its limit."];return;}[self.received appendData:d];}
// A pinned (LAN) pairing trusts only its companion's own certificate, as in the other bridges.
- (void)URLSession:(NSURLSession*)s didReceiveChallenge:(NSURLAuthenticationChallenge*)c completionHandler:(void(^)(NSURLSessionAuthChallengeDisposition,NSURLCredential*))done{
  if(STMPinnedTrust(c,self.pairing,done))self.pinRejected=YES;
}
- (void)URLSession:(NSURLSession*)s task:(NSURLSessionTask*)t didCompleteWithError:(NSError*)e{
  if(t!=self.task)return;if(e){if(self.pinRejected){[self fail:@"certificate-changed" message:@"Your computer's companion presented a different certificate. Scan a new QR code from it."];return;}[self fail:STMTransportError(e) message:@"The companion response was interrupted."];return;}
  NSError *pe=nil;NSDictionary *p=STMReadPairing(&pe);if(pe||![p isEqual:self.pairing]){[self fail:@"pairing-changed" message:@"Companion connection changed."];return;}
  NSString *body=[[NSString alloc] initWithData:self.received encoding:NSUTF8StringEncoding];if(!body){[self fail:@"invalid-response" message:@"Companion response was unreadable."];return;}
  RCTPromiseResolveBlock resolve=self.resolve;self.resolve=nil;self.reject=nil;self.task=nil;self.received=nil;[self.session finishTasksAndInvalidate];self.session=nil;
  resolve(@{@"status":@(self.response.statusCode),@"body":body});
}
RCT_REMAP_METHOD(cancel,cancelResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject){[self fail:@"cancelled" message:@"Printer request cancelled."];resolve(nil);}
@end
