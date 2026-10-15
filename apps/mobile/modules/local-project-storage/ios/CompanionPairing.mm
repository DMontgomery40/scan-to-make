#import "CompanionPairing.h"
#import <React/RCTBridgeModule.h>
#import <Security/Security.h>
#import <TargetConditionals.h>

NSString * const STMPairingChanged = @"STMPairingChanged";
static NSDictionary *Query(void) {
  return @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService:@"org.scantomake.companion.v1",
    (__bridge id)kSecAttrAccount:@"current", (__bridge id)kSecAttrSynchronizable:@NO};
}
static BOOL Matches(id value, NSString *pattern) {
  return [value isKindOfClass:NSString.class] && [[NSPredicate predicateWithFormat:@"SELF MATCHES %@", pattern] evaluateWithObject:value];
}
BOOL STMFixtureURL(NSURL *url) {
#if TARGET_OS_SIMULATOR
  return [url.host isEqual:@"127.0.0.1"] && (([url.scheme isEqual:@"http"] && [url.port isEqual:@9078]) || ([url.scheme isEqual:@"https"] && [url.port isEqual:@9079]));
#else
  return NO;
#endif
}
BOOL STMLocalGenerationAllowed(void) {
#if TARGET_OS_SIMULATOR
  return ![NSUserDefaults.standardUserDefaults boolForKey:@"STMCompanionSelected"];
#else
  return NO;
#endif
}
NSURL *STMCompanionBaseURL(NSString *value) {
  if (![value isKindOfClass:NSString.class] || value.length > 300) return nil;
  NSURLComponents *c = [NSURLComponents componentsWithString:value];
  if (!c || c.user || c.password || c.query || c.fragment || (c.path.length && ![c.path isEqual:@"/"])) return nil;
  BOOL remote = [c.scheme isEqual:@"https"] && !c.port && Matches(c.host, @"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+ts\\.net");
  if (!remote && !STMFixtureURL(c.URL)) return nil;
  c.path = @"";
  return c.URL;
}
static BOOL ValidRecord(NSDictionary *r) {
  return [r isKindOfClass:NSDictionary.class] && STMCompanionBaseURL(r[@"baseUrl"]) &&
    [r[@"protocolVersion"] isEqual:@"0.1.0"] && [r[@"deviceId"] isKindOfClass:NSString.class] && [[NSUUID alloc] initWithUUIDString:r[@"deviceId"]] &&
    Matches(r[@"token"], @"[A-Za-z0-9_-]{43}") && [r[@"expiresAt"] isKindOfClass:NSNumber.class] &&
    [r[@"expiresAt"] doubleValue] > 0 && [r[@"scopes"] isKindOfClass:NSArray.class] &&
    [r[@"scopes"] containsObject:@"generation:health"] && [r[@"scopes"] containsObject:@"generation:create"];
}
NSDictionary *STMReadPairing(NSError **error) {
  NSMutableDictionary *q = [Query() mutableCopy]; q[(__bridge id)kSecReturnData] = @YES;
  CFTypeRef value = NULL; OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)q, &value);
  if (status == errSecItemNotFound) return nil;
  if (status != errSecSuccess) { if (error) *error = [NSError errorWithDomain:@"CompanionSecureStorage" code:status userInfo:nil]; return nil; }
  NSData *data = CFBridgingRelease(value);
  NSDictionary *r = data.length < 8192 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (!ValidRecord(r)) { if (error) *error = [NSError errorWithDomain:@"CompanionSecureStorage" code:-1 userInfo:nil]; return nil; }
  return r;
}
NSDictionary *STMPairingMetadata(NSDictionary *r) {
  if (!r) return @{ @"state":@"disconnected" };
  return @{ @"state":[r[@"expiresAt"] doubleValue] <= NSDate.date.timeIntervalSince1970 * 1000 ? @"expired" : @"paired",
    @"baseUrl":r[@"baseUrl"], @"deviceId":r[@"deviceId"], @"expiresAt":r[@"expiresAt"], @"fixture":@(STMFixtureURL(STMCompanionBaseURL(r[@"baseUrl"]))) };
}
NSString *STMTransportError(NSError *error) {
  if ([error.domain isEqual:NSURLErrorDomain]) {
    if (error.code <= NSURLErrorSecureConnectionFailed && error.code >= NSURLErrorClientCertificateRequired) return @"certificate";
    if (error.code == NSURLErrorTimedOut) return @"timeout";
  }
  return @"network";
}
@interface CompanionPairing : NSObject <RCTBridgeModule, NSURLSessionDataDelegate>
@property NSURLSession *session;
@property NSURLSessionDataTask *task;
@property NSMutableData *bytes;
@property NSDictionary *pending;
@property NSDictionary *snapshot;
@property NSInteger status;
@property BOOL pairing;
@property (copy) RCTPromiseResolveBlock resolve;
@property (copy) RCTPromiseRejectBlock reject;
@end
@implementation CompanionPairing
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (void)clear {
  [self.task cancel]; self.task = nil; [self.session invalidateAndCancel]; self.session = nil;
  self.bytes = nil; self.pending = nil; self.snapshot = nil; self.resolve = nil; self.reject = nil;
}
- (void)fail:(NSString *)code {
  RCTPromiseRejectBlock reject = self.reject; [self clear];
  if (reject) reject(code, @"Companion connection could not complete.", nil);
}
RCT_REMAP_METHOD(status, statusResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil; NSDictionary *r = STMReadPairing(&error);
  if (error) reject(@"secure-storage", @"Unlock this device and try again. Stored pairing could not be read.", nil);
  else resolve(STMPairingMetadata(r));
}
RCT_REMAP_METHOD(cancel, cancelResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) { [self fail:@"cancelled"]; resolve(nil); }
RCT_REMAP_METHOD(disconnect, disconnectResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [self fail:@"cancelled"];
  [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"STMCompanionSelected"];
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)Query());
  if (status != errSecSuccess && status != errSecItemNotFound) { reject(@"secure-storage", @"Pairing could not be removed. Unlock this device and retry.", nil); return; }
  [[NSNotificationCenter defaultCenter] postNotificationName:STMPairingChanged object:nil];
  resolve(@{ @"state":@"disconnected" });
}
- (void)start:(NSMutableURLRequest *)request resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  self.resolve = resolve; self.reject = reject; self.bytes = [NSMutableData new];
  NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  config.timeoutIntervalForRequest = 10; config.timeoutIntervalForResource = 15;
  config.URLCache = nil; config.HTTPShouldSetCookies = NO;
  self.session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:NSOperationQueue.mainQueue];
  self.task = [self.session dataTaskWithRequest:request]; [self.task resume];
}
RCT_REMAP_METHOD(pair, pairURL:(NSString *)baseUrl code:(NSString *)code deviceName:(NSString *)name resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (self.task) { reject(@"busy", @"A connection check is already running.", nil); return; }
  NSURL *url = STMCompanionBaseURL(baseUrl);
  if (!url || !Matches(code, @"[A-Za-z0-9_-]{32}") || !Matches(name, @"[^\\x00-\\x1f\\x7f]{1,80}")) { reject(@"invalid-invitation", @"Check the companion address and pairing invitation.", nil); return; }
  self.pairing = YES; self.pending = @{ @"baseUrl":url.absoluteString };
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[url URLByAppendingPathComponent:@"v1/pair"]];
  request.HTTPMethod = @"POST";
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{@"code":code,@"deviceName":name} options:0 error:nil];
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  [self start:request resolve:resolve reject:reject];
}
RCT_REMAP_METHOD(check, checkResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (self.task) { reject(@"busy", @"A connection check is already running.", nil); return; }
  NSError *error = nil; NSDictionary *r = STMReadPairing(&error);
  if (error || !r || [r[@"expiresAt"] doubleValue] <= NSDate.date.timeIntervalSince1970*1000) { reject(error ? @"secure-storage" : @"pairing-required", @"Connect this device to a companion.", nil); return; }
  self.pairing = NO; self.snapshot = r;
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[STMCompanionBaseURL(r[@"baseUrl"]) URLByAppendingPathComponent:@"healthz"]];
  [request setValue:[@"Bearer " stringByAppendingString:r[@"token"]] forHTTPHeaderField:@"Authorization"];
  [request setValue:r[@"deviceId"] forHTTPHeaderField:@"X-Scan-Device"];
  [self start:request resolve:resolve reject:reject];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request completionHandler:(void (^)(NSURLRequest *))completionHandler { completionHandler(nil); }
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  if (task != self.task) { completionHandler(NSURLSessionResponseCancel); return; }
  if (response.expectedContentLength > 16384) { completionHandler(NSURLSessionResponseCancel); [self fail:@"invalid-response"]; return; }
  self.status = [(NSHTTPURLResponse *)response statusCode]; completionHandler(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  if (task != self.task) return;
  if (data.length > 16384-self.bytes.length) { [self fail:@"invalid-response"]; return; }
  [self.bytes appendData:data];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  if (task != self.task) return;
  if (error) { [self fail:STMTransportError(error)]; return; }
  if (self.status != 200) {
    NSString *code = self.status == 401 ? @"unauthorized" : self.status == 403 ? @"forbidden" : self.status == 429 ? @"rate-limited" : self.status >= 300 && self.status < 400 ? @"wrong-host" : @"unavailable";
    [self fail:code]; return;
  }
  id json = [NSJSONSerialization JSONObjectWithData:self.bytes options:0 error:nil];
  if (![json isKindOfClass:NSDictionary.class]) { [self fail:@"invalid-response"]; return; }
  NSDictionary *result;
  if (self.pairing) {
    NSMutableDictionary *r = [json mutableCopy]; r[@"baseUrl"] = self.pending[@"baseUrl"];
    if (!ValidRecord(r) || [r[@"expiresAt"] doubleValue] <= NSDate.date.timeIntervalSince1970*1000 || [r[@"expiresAt"] doubleValue] > NSDate.date.timeIntervalSince1970*1000+31.0*86400000) { [self fail:@"invalid-response"]; return; }
    NSData *data = [NSJSONSerialization dataWithJSONObject:r options:0 error:nil];
    NSDictionary *attrs = @{(__bridge id)kSecValueData:data, (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly};
    OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)Query(), (__bridge CFDictionaryRef)attrs);
    if (status == errSecItemNotFound) { NSMutableDictionary *q = [Query() mutableCopy]; [q addEntriesFromDictionary:attrs]; status = SecItemAdd((__bridge CFDictionaryRef)q, NULL); }
    if (status != errSecSuccess) { [self fail:@"secure-storage"]; return; }
    [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"STMCompanionSelected"];
    [[NSNotificationCenter defaultCenter] postNotificationName:STMPairingChanged object:nil];
    result = STMPairingMetadata(r);
  } else {
    NSError *readError = nil; NSDictionary *current = STMReadPairing(&readError);
    if (readError || ![current isEqual:self.snapshot]) { [self fail:@"pairing-changed"]; return; }
    if (![json[@"protocolVersion"] isEqual:@"0.1.0"]) { [self fail:@"invalid-response"]; return; }
    result = STMPairingMetadata(current);
  }
  RCTPromiseResolveBlock resolve = self.resolve; [self clear]; resolve(result);
}
- (void)invalidate { dispatch_async(dispatch_get_main_queue(), ^{ [self fail:@"cancelled"]; }); }
@end
