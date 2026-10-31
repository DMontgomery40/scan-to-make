#import "NearbyPairing.h"
#import "CompanionPairing.h"
#import <React/RCTBridgeModule.h>
#import <CommonCrypto/CommonDigest.h>
#import <Network/Network.h>
#import <Security/Security.h>
#include <arpa/inet.h>
#include <dns_sd.h>

// Tests on macOS browse a private type so they never show up beside a real Mac.
#ifndef STM_NEARBY_SERVICE_TYPE
#define STM_NEARBY_SERVICE_TYPE "_scantomake._tcp"
#endif

static NSData *NearbySHA256(NSData *data) {
  uint8_t out[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, out);
  return [NSData dataWithBytes:out length:sizeof out];
}
// The tag with its terminating zero byte, then each part: the contract's `tag || 0x00 || ...`.
static NSData *NearbyTagged(const char *tag, NSArray<NSData *> *parts) {
  NSMutableData *input = [NSMutableData dataWithBytes:tag length:strlen(tag) + 1];
  for (NSData *part in parts) [input appendData:part];
  return input;
}
static BOOL NearbyMatches(id value, NSString *pattern) {
  return [value isKindOfClass:NSString.class] && [[NSPredicate predicateWithFormat:@"SELF MATCHES %@", pattern] evaluateWithObject:value];
}
static NSString *NearbyHex(NSData *data) {
  NSMutableString *text = [NSMutableString stringWithCapacity:data.length * 2];
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  for (NSUInteger i = 0; i < data.length; i++) [text appendFormat:@"%02x", bytes[i]];
  return text;
}
NSData *STMNearbyCommit(NSData *key) {
  return key.length == 32 ? NearbySHA256(NearbyTagged("scantomake nearby v1 commit", @[key])) : nil;
}
NSString *STMNearbyCode(NSData *publicKeySha256, NSData *key, NSData *nonce) {
  if (publicKeySha256.length != 32 || key.length != 32 || nonce.length != 32) return nil;
  NSData *digest = NearbySHA256(NearbyTagged("scantomake nearby v1 code", @[publicKeySha256, key, nonce]));
  const uint8_t *d = (const uint8_t *)digest.bytes;
  uint64_t value = 0;
  for (int i = 0; i < 8; i++) value = value << 8 | d[i];
  return [NSString stringWithFormat:@"%06llu", (unsigned long long)(value % 1000000)];
}
NSString *STMBase64URL(NSData *data) {
  NSString *text = [data base64EncodedStringWithOptions:0];
  text = [text stringByReplacingOccurrencesOfString:@"+" withString:@"-"];
  text = [text stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  return [text stringByReplacingOccurrencesOfString:@"=" withString:@""];
}
NSData *STMNearbyBytes(id text) {
  if (!NearbyMatches(text, @"[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]")) return nil;
  NSString *standard = [[text stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
  NSData *data = [[NSData alloc] initWithBase64EncodedString:[standard stringByAppendingString:@"="] options:0];
  return data.length == 32 ? data : nil;
}
NSData *STMNearbyTrust(NSURLAuthenticationChallenge *challenge, NSURL *base, NSData *seen) {
  NSURLProtectionSpace *space = challenge.protectionSpace;
  if (!base || ![space.authenticationMethod isEqual:NSURLAuthenticationMethodServerTrust] || !space.serverTrust) return nil;
  // The protection space reports 0 for the scheme's default port.
  NSInteger expected = base.port ? base.port.integerValue : 443, actual = space.port ?: 443;
  if (actual != expected || [space.host caseInsensitiveCompare:base.host] != NSOrderedSame) return nil;
  CFArrayRef chain = SecTrustCopyCertificateChain(space.serverTrust);
  SecCertificateRef leaf = chain && CFArrayGetCount(chain) > 0 ? (SecCertificateRef)CFArrayGetValueAtIndex(chain, 0) : NULL;
  NSData *der = leaf ? CFBridgingRelease(SecCertificateCopyData(leaf)) : nil;
  if (chain) CFRelease(chain);
  NSData *spki = STMSubjectPublicKeyInfo(der);
  NSData *key = spki ? NearbySHA256(spki) : nil;
  return key && (!seen || [seen isEqualToData:key]) ? key : nil;
}

// Only the address rules of STMPinnedBaseURL apply to a resolved address; any well-formed pin will do.
static NSString * const AnyPin = @"0000000000000000000000000000000000000000000000000000000000000000";
// The largest reply body accepted; enforced while it arrives, never after buffering it.
static const NSUInteger NearbyMaxBody = 16384;
static NSString *Failure(NSInteger status) {
  return status == 401 ? @"nearby-expired" : status == 403 ? @"forbidden" : status == 429 ? @"rate-limited" : @"unavailable";
}

/**
 * The phone's half of nearby pairing. browse() lists Macs advertising the service;
 * start() resolves one to an IPv4 address, commits to a fresh key, reveals it and returns
 * the code; result() waits for Allow and returns the v2 pairing link, which JavaScript
 * then pairs with through CompanionPairing.pairAddresses, pinned to the same key.
 * The key and session never leave native code. One session at a time.
 */
// One request in flight: its callback, the reply so far, and the attempt it belongs to.
@interface NearbyExchange : NSObject
@property (copy) void (^done)(NSInteger status, id json, NSString *failure);
@property NSMutableData *bytes;
@property NSInteger status;
@property BOOL oversized;
@property NSUInteger generation;
@end
@implementation NearbyExchange
@end

@interface NearbyPairing : NSObject <RCTBridgeModule, NSURLSessionDataDelegate>
@property (strong) nw_browser_t browser;
@property (strong) nw_connection_t resolver;
@property NSMutableDictionary<NSString *, nw_browse_result_t> *found;
@property NSURLSession *session;
@property NSURLSessionDataTask *task;
@property NSMapTable<NSURLSessionTask *, NearbyExchange *> *exchanges;
@property NSURL *base;
@property NSData *seen;
@property NSData *key;
@property NSString *sessionId;
@property BOOL rejected;
// Bumped by every reset: callbacks from an earlier attempt see a different value and stop.
@property NSUInteger generation;
@end

@implementation NearbyPairing
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (void)stopBrowsing {
  if (self.browser) nw_browser_cancel(self.browser);
  self.browser = nil;
}
- (void)reset {
  self.generation++;
  [self.task cancel]; self.task = nil;
  [self.session invalidateAndCancel]; self.session = nil;
  if (self.resolver) nw_connection_cancel(self.resolver);
  self.resolver = nil;
  self.base = nil; self.seen = nil; self.key = nil; self.sessionId = nil;
}
- (NSArray *)list {
  NSMutableArray *macs = [NSMutableArray new];
  for (NSString *name in [self.found.allKeys sortedArrayUsingSelector:@selector(localizedStandardCompare:)]) {
    __block NSString *hint = nil;
    nw_txt_record_t txt = nw_browse_result_copy_txt_record_object(self.found[name]);
    // TXT is only a hint (anyone on the Wi-Fi can advertise): the code is the proof.
    if (txt) nw_txt_record_access_key(txt, "k", ^bool(const char *key, const nw_txt_record_find_key_t result, const uint8_t *value, const size_t length) {
      NSString *text = result == nw_txt_record_find_key_non_empty_value ? [[NSString alloc] initWithBytes:value length:length encoding:NSASCIIStringEncoding] : nil;
      if (NearbyMatches(text, @"[a-f0-9]{64}")) hint = text;
      return true;
    });
    [macs addObject:hint ? @{ @"name":name, @"publicKeySha256":hint } : @{ @"name":name }];
  }
  return macs;
}
static NSString *ServiceName(nw_browse_result_t result) {
  nw_endpoint_t endpoint = nw_browse_result_copy_endpoint(result); // Keeps the name's bytes alive.
  const char *name = endpoint ? nw_endpoint_get_bonjour_service_name(endpoint) : NULL;
  return name ? @(name) : nil;
}
static BOOL PolicyDenied(nw_error_t error) {
  return error && nw_error_get_error_domain(error) == nw_error_domain_dns && nw_error_get_error_code(error) == kDNSServiceErr_PolicyDenied;
}

RCT_REMAP_METHOD(browse, browse:(double)timeoutMs resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [self stopBrowsing];
  self.found = [NSMutableDictionary new];
  nw_browse_descriptor_t descriptor = nw_browse_descriptor_create_bonjour_service(STM_NEARBY_SERVICE_TYPE, "local.");
  nw_browse_descriptor_set_include_txt_record(descriptor, true);
  nw_browser_t browser = nw_browser_create(descriptor, nw_parameters_create());
  self.browser = browser;
  nw_browser_set_queue(browser, dispatch_get_main_queue());
  __weak NearbyPairing *weak = self;
  __block BOOL settled = NO;
  nw_browser_set_browse_results_changed_handler(browser, ^(nw_browse_result_t before, nw_browse_result_t after, bool complete) {
    NearbyPairing *strong = weak;
    if (!strong || strong.browser != browser) return;
    // Added: only after. Removed: only before. Changed (TXT): both, under one name.
    if (before) { NSString *name = ServiceName(before); if (name) [strong.found removeObjectForKey:name]; }
    if (after) { NSString *name = ServiceName(after); if (name) strong.found[name] = after; }
  });
  nw_browser_set_state_changed_handler(browser, ^(nw_browser_state_t state, nw_error_t error) {
    if (settled) return;
    // cancel(), or a new browse, before the list was returned.
    if (state == nw_browser_state_cancelled) { settled = YES; reject(@"cancelled", @"Cancelled.", nil); return; }
    NearbyPairing *strong = weak;
    if (!strong || strong.browser != browser) return;
    if (state == nw_browser_state_failed || (state == nw_browser_state_waiting && PolicyDenied(error))) {
      settled = YES; [strong stopBrowsing];
      if (PolicyDenied(error)) reject(@"local-network", @"Local Network access is off for Scan to Make.", nil);
      else reject(@"network", @"Nearby Macs could not be listed.", nil);
    }
  });
  nw_browser_start(browser);
  double wait = MIN(MAX(timeoutMs, 500), 10000);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
    NearbyPairing *strong = weak;
    if (settled || !strong || strong.browser != browser) return;
    // The browser keeps running, so start() sees Macs that appear later too.
    settled = YES; resolve([strong list]);
  });
}

// The advertised service's IPv4 address and port, as an origin the pin rules accept.
- (void)resolve:(nw_endpoint_t)endpoint then:(void (^)(NSURL *base, NSString *failure))then {
  nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
  nw_protocol_stack_t stack = nw_parameters_copy_default_protocol_stack(parameters);
  nw_ip_options_set_version(nw_protocol_stack_copy_internet_protocol(stack), nw_ip_version_4);
  nw_connection_t connection = nw_connection_create(endpoint, parameters);
  self.resolver = connection;
  __block BOOL finished = NO;
  __weak NearbyPairing *weak = self;
  void (^finish)(NSURL *, NSString *) = ^(NSURL *base, NSString *failure) {
    if (finished) return;
    finished = YES;
    nw_connection_cancel(connection);
    if (weak.resolver == connection) weak.resolver = nil;
    then(base, failure);
  };
  nw_connection_set_queue(connection, dispatch_get_main_queue());
  nw_connection_set_state_changed_handler(connection, ^(nw_connection_state_t state, nw_error_t error) {
    if (state == nw_connection_state_ready) {
      nw_path_t path = nw_connection_copy_current_path(connection);
      nw_endpoint_t remote = path ? nw_path_copy_effective_remote_endpoint(path) : nil;
      const struct sockaddr *address = remote && nw_endpoint_get_type(remote) == nw_endpoint_type_address ? nw_endpoint_get_address(remote) : NULL;
      char host[INET_ADDRSTRLEN];
      if (address && address->sa_family == AF_INET && inet_ntop(AF_INET, &((const struct sockaddr_in *)address)->sin_addr, host, sizeof host)) {
        NSURL *base = STMPinnedBaseURL([NSString stringWithFormat:@"https://%s:%u", host, nw_endpoint_get_port(remote)], AnyPin);
        finish(base, base ? nil : @"network");
      } else finish(nil, @"network");
    } else if (state == nw_connection_state_failed) finish(nil, @"network");
    else if (state == nw_connection_state_cancelled) finish(nil, @"cancelled");
    else if (state == nw_connection_state_waiting && PolicyDenied(error)) finish(nil, @"local-network");
  });
  nw_connection_start(connection);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ finish(nil, @"timeout"); });
}

- (void)post:(NSString *)path body:(NSDictionary *)body timeout:(NSTimeInterval)timeout done:(void (^)(NSInteger status, id json, NSString *failure))done {
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[self.base URLByAppendingPathComponent:path]];
  request.HTTPMethod = @"POST"; request.timeoutInterval = timeout;
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  self.rejected = NO;
  NearbyExchange *exchange = [NearbyExchange new];
  exchange.done = done; exchange.bytes = [NSMutableData new]; exchange.generation = self.generation;
  if (!self.exchanges) self.exchanges = [NSMapTable strongToStrongObjectsMapTable];
  NSURLSessionDataTask *task = [self.session dataTaskWithRequest:request];
  [self.exchanges setObject:exchange forKey:task];
  self.task = task;
  [task resume];
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  NearbyExchange *exchange = [self.exchanges objectForKey:task];
  if (!exchange || response.expectedContentLength > (long long)NearbyMaxBody) { exchange.oversized = YES; completionHandler(NSURLSessionResponseCancel); return; }
  exchange.status = [(NSHTTPURLResponse *)response statusCode];
  completionHandler(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  NearbyExchange *exchange = [self.exchanges objectForKey:task];
  if (!exchange || exchange.oversized) return;
  if (data.length > NearbyMaxBody - exchange.bytes.length) { exchange.oversized = YES; [task cancel]; return; }
  [exchange.bytes appendData:data];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  NearbyExchange *exchange = [self.exchanges objectForKey:task];
  if (!exchange) return;
  [self.exchanges removeObjectForKey:task];
  if (self.task == task) self.task = nil;
  // Every request settles: one from an attempt that was reset reports "cancelled".
  if (exchange.generation != self.generation) { exchange.done(0, nil, @"cancelled"); return; }
  if (exchange.oversized) { exchange.done(0, nil, @"invalid-response"); return; }
  if (error) { exchange.done(0, nil, self.rejected ? @"certificate-changed" : STMTransportError(error)); return; }
  id json = exchange.bytes.length ? [NSJSONSerialization JSONObjectWithData:exchange.bytes options:0 error:nil] : nil;
  exchange.done(exchange.status, [json isKindOfClass:NSDictionary.class] ? json : nil, nil);
}

RCT_REMAP_METHOD(start, start:(NSString *)name deviceName:(NSString *)deviceName resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  // A request in flight is busy; an idle session left by an abandoned attempt is simply replaced.
  if (self.task || self.resolver) { reject(@"busy", @"A nearby pairing is already running.", nil); return; }
  nw_browse_result_t found = [name isKindOfClass:NSString.class] ? self.found[name] : nil;
  if (!found || !NearbyMatches(deviceName, @"[^\\x00-\\x1f\\x7f]{1,80}")) { reject(@"invalid-invitation", @"That Mac is no longer nearby.", nil); return; }
  [self reset];
  NSUInteger generation = self.generation;
  __weak NearbyPairing *weak = self;
  void (^fail)(NSString *) = ^(NSString *code) {
    NearbyPairing *strong = weak;
    if (strong && generation == strong.generation) [strong reset];
    reject(code, @"Nearby pairing could not complete.", nil);
  };
  [self resolve:nw_browse_result_copy_endpoint(found) then:^(NSURL *base, NSString *failure) {
    NearbyPairing *strong = weak;
    if (!strong || generation != strong.generation) { fail(@"cancelled"); return; }
    if (!base) { fail(failure); return; }
    uint8_t bytes[32];
    if (SecRandomCopyBytes(kSecRandomDefault, sizeof bytes, bytes) != errSecSuccess) { fail(@"unavailable"); return; }
    strong.base = base; strong.key = [NSData dataWithBytes:bytes length:sizeof bytes];
    NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    config.timeoutIntervalForResource = 45; config.URLCache = nil; config.HTTPShouldSetCookies = NO;
    strong.session = [NSURLSession sessionWithConfiguration:config delegate:strong delegateQueue:NSOperationQueue.mainQueue];
    // Commit to the key before the Mac's nonce exists.
    [strong post:@"v1/pair/nearby" body:@{ @"commit":STMBase64URL(STMNearbyCommit(strong.key)), @"deviceName":deviceName } timeout:10 done:^(NSInteger status, id json, NSString *failure) {
      if (failure || status != 200) { fail(failure ?: Failure(status)); return; }
      NSData *nonce = STMNearbyBytes(json[@"nonce"]);
      NSUUID *session = NearbyMatches(json[@"session"], @"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") ? [[NSUUID alloc] initWithUUIDString:json[@"session"]] : nil;
      if (!nonce || !session || ![json[@"expiresAt"] isKindOfClass:NSNumber.class]) { fail(@"invalid-response"); return; }
      NSNumber *expiresAt = json[@"expiresAt"];
      strong.sessionId = json[@"session"];
      [strong post:@"v1/pair/nearby/reveal" body:@{ @"session":strong.sessionId, @"key":STMBase64URL(strong.key) } timeout:10 done:^(NSInteger status, id json, NSString *failure) {
        if (failure || status != 200) { fail(failure ?: Failure(status)); return; }
        NSString *code = STMNearbyCode(strong.seen, strong.key, nonce);
        if (![json[@"status"] isEqual:@"waiting"] || !code) { fail(@"invalid-response"); return; }
        resolve(@{ @"code":code, @"publicKeySha256":NearbyHex(strong.seen), @"baseUrl":strong.base.absoluteString, @"expiresAt":expiresAt });
      }];
    }];
  }];
}

// One wait for the Mac's answer (up to 25 s on the Mac's side). "waiting" means ask again.
RCT_REMAP_METHOD(result, resultResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (!self.sessionId || self.task) { reject(self.task ? @"busy" : @"cancelled", @"No nearby pairing is waiting.", nil); return; }
  __weak NearbyPairing *weak = self;
  [self post:@"v1/pair/nearby/result" body:@{ @"session":self.sessionId, @"key":STMBase64URL(self.key) } timeout:40 done:^(NSInteger status, id json, NSString *failure) {
    NearbyPairing *strong = weak;
    // A dropped connection keeps the session: the caller may ask again.
    if (failure) { reject(failure, @"Your Mac didn't answer.", nil); return; }
    if (status != 200) { [strong reset]; reject(Failure(status), @"Nearby pairing could not complete.", nil); return; }
    NSString *state = json[@"status"];
    if ([state isEqual:@"waiting"] && [json[@"expiresAt"] isKindOfClass:NSNumber.class]) { resolve(@{ @"status":state, @"expiresAt":json[@"expiresAt"] }); return; }
    [strong reset];
    if ([state isEqual:@"denied"]) resolve(@{ @"status":state });
    else if ([state isEqual:@"allowed"] && [json[@"link"] isKindOfClass:NSString.class] && [json[@"link"] length] <= 4096) resolve(@{ @"status":state, @"link":json[@"link"] });
    else reject(@"invalid-response", @"Nearby pairing could not complete.", nil);
  }];
}

RCT_REMAP_METHOD(cancel, cancelResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [self reset]; [self stopBrowsing]; self.found = nil; resolve(nil);
}

- (void)URLSession:(NSURLSession *)session didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completionHandler {
  if (![challenge.protectionSpace.authenticationMethod isEqual:NSURLAuthenticationMethodServerTrust]) { completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil); return; }
  NSData *key = STMNearbyTrust(challenge, self.base, self.seen);
  if (key) { self.seen = key; completionHandler(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialForTrust:challenge.protectionSpace.serverTrust]); return; }
  self.rejected = self.seen != nil;
  completionHandler(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request completionHandler:(void (^)(NSURLRequest *))completionHandler { completionHandler(nil); }
- (void)invalidate { dispatch_async(dispatch_get_main_queue(), ^{ [self reset]; [self stopBrowsing]; }); }
@end
