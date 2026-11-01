#import "CompanionPairing.h"
#import "ContentHash.h"
#import <React/RCTBridgeModule.h>
#import <Security/Security.h>
#import <TargetConditionals.h>
#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#endif

NSString * const STMPairingChanged = @"STMPairingChanged";
static NSDictionary *Query(void) {
  return @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService:@"org.scantomake.companion.v1",
    (__bridge id)kSecAttrAccount:@"current", (__bridge id)kSecAttrSynchronizable:@NO};
}
static BOOL Matches(id value, NSString *pattern) {
  return [value isKindOfClass:NSString.class] && [[NSPredicate predicateWithFormat:@"SELF MATCHES %@", pattern] evaluateWithObject:value];
}
// This identity is independent of the current Mac credential. Forgetting a Mac
// must not make the next pairing look like a different phone. It cannot sync or
// migrate to another device, and only its hash is stored by a companion.
static NSString *InstallationKey(NSError **error) {
  NSMutableDictionary *query = [Query() mutableCopy];
  query[(__bridge id)kSecAttrAccount] = @"installation";
  NSMutableDictionary *read = [query mutableCopy]; read[(__bridge id)kSecReturnData] = @YES;
  CFTypeRef value = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)read, &value);
  if (status == errSecSuccess) {
    NSData *data = CFBridgingRelease(value);
    NSString *key = data.length == 43 ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
    if (Matches(key, @"[A-Za-z0-9_-]{43}")) return key;
    status = errSecDecode;
  } else if (status == errSecItemNotFound) {
    uint8_t bytes[32];
    status = SecRandomCopyBytes(kSecRandomDefault, sizeof bytes, bytes);
    if (status == errSecSuccess) {
      NSString *key = [[NSData dataWithBytes:bytes length:sizeof bytes] base64EncodedStringWithOptions:0];
      key = [[[key stringByReplacingOccurrencesOfString:@"+" withString:@"-"] stringByReplacingOccurrencesOfString:@"/" withString:@"_"] stringByReplacingOccurrencesOfString:@"=" withString:@""];
      query[(__bridge id)kSecValueData] = [key dataUsingEncoding:NSUTF8StringEncoding];
      query[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
      status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
      if (status == errSecSuccess) return key;
      if (status == errSecDuplicateItem) return InstallationKey(error);
    }
  }
  if (error) *error = [NSError errorWithDomain:@"CompanionSecureStorage" code:status userInfo:nil];
  return nil;
}
static NSString *DeviceName(NSString *installationKey) {
  NSString *chosen = [NSUserDefaults.standardUserDefaults stringForKey:@"CounterpartDeviceName"];
  if (Matches(chosen, @"[^\\x00-\\x1f\\x7f]{1,80}")) return chosen;
#if TARGET_OS_IOS
  NSString *name = UIDevice.currentDevice.name;
#else
  NSString *name = @"iPhone";
#endif
  // iOS normally returns a generic name without Apple's device-name entitlement.
  // A short hash makes that default distinguishable; the person can rename it.
  if (!Matches(name, @"[^\\x00-\\x1f\\x7f]{1,70}")) name = @"iPhone";
  if ([@[@"iPhone", @"iPad", @"iPod touch"] containsObject:name])
    return [NSString stringWithFormat:@"%@ (%@)", name, [[STMHash([installationKey dataUsingEncoding:NSUTF8StringEncoding]) substringToIndex:4] uppercaseString]];
  return name;
}
static BOOL SameCompanion(NSDictionary *previous, NSDictionary *invitation) {
  if (!previous) return NO;
  if (invitation[@"publicKeySha256"] || previous[@"publicKeySha256"])
    return previous[@"publicKeySha256"] && [previous[@"publicKeySha256"] isEqual:invitation[@"publicKeySha256"]];
  if (invitation[@"certificateSha256"] || previous[@"certificateSha256"])
    return previous[@"certificateSha256"] && [previous[@"certificateSha256"] isEqual:invitation[@"certificateSha256"]];
  return [previous[@"baseUrl"] isEqual:invitation[@"baseUrl"]];
}
BOOL STMFixtureURL(NSURL *url) {
#if TARGET_OS_SIMULATOR
  return [url.host isEqual:@"127.0.0.1"] && (([url.scheme isEqual:@"http"] && [url.port isEqual:@9078]) || ([url.scheme isEqual:@"https"] && [url.port isEqual:@9079]));
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
static BOOL ValidPin(id pin) { return Matches(pin, @"[a-f0-9]{64}"); }
NSURL *STMPinnedBaseURL(NSString *value, NSString *pin) {
  if (!ValidPin(pin) || ![value isKindOfClass:NSString.class] || value.length > 300) return nil;
  NSURLComponents *c = [NSURLComponents componentsWithString:value];
  if (!c || ![c.scheme isEqual:@"https"] || !c.host.length || c.user || c.password || c.query || c.fragment || (c.path.length && ![c.path isEqual:@"/"])) return nil;
  // A self-signed certificate is only usable where ATS's local-networking
  // exemption applies: IP addresses (LAN or VPN), .local names and single-label names.
  NSString *host = c.host.lowercaseString;
  BOOL address = Matches(host, @"[0-9]{1,3}(\\.[0-9]{1,3}){3}") || [host containsString:@":"];
  if (!address && ![host hasSuffix:@".local"] && [host containsString:@"."]) return nil;
  c.path = @"";
  return c.URL;
}
// Pairing link v2: up to 8 distinct pinnable origins (no path or trailing slash), in the order to try.
NSArray<NSString *> *STMPinnedAddresses(id value, NSString *pin) {
  if (![value isKindOfClass:NSArray.class] || [value count] < 1 || [value count] > 8) return nil;
  NSMutableSet *seen = [NSMutableSet new];
  for (id address in value) {
    if (!STMPinnedBaseURL(address, pin) || [address hasSuffix:@"/"] || [seen containsObject:[address lowercaseString]]) return nil;
    [seen addObject:[address lowercaseString]];
  }
  return value;
}
// A v2 record's baseUrl is where it paired and names the companion for local storage
// (every bridge keys its state by baseUrl and deviceId); requests go to activeUrl,
// the last address that answered, when there is one.
NSURL *STMPairingBaseURL(NSDictionary *r) {
  if (![r isKindOfClass:NSDictionary.class]) return nil;
  if (r[@"publicKeySha256"]) return STMPinnedBaseURL(r[@"activeUrl"] ?: r[@"baseUrl"], r[@"publicKeySha256"]);
  return r[@"certificateSha256"] ? STMPinnedBaseURL(r[@"baseUrl"], r[@"certificateSha256"]) : STMCompanionBaseURL(r[@"baseUrl"]);
}
// The addresses to try for a record: the last one that answered, then the rest in order.
NSArray<NSString *> *STMAttemptOrder(NSDictionary *r) {
  NSString *first = r[@"activeUrl"] ?: r[@"baseUrl"];
  NSMutableArray *order = [NSMutableArray arrayWithObject:first];
  for (NSString *address in r[@"addresses"] ?: @[]) if (![address isEqual:first]) [order addObject:address];
  return order;
}
// Only failures that say nothing about the companion move on to the next address:
// unreachable, timed out, or another server (any other certificate or key) at that address.
BOOL STMTryNextAddress(NSString *failure) {
  return [@[@"network", @"timeout", @"certificate", @"certificate-changed"] containsObject:failure];
}
// One DER element at offset, bounded by length: its tag, content start and end.
static BOOL DERElement(const uint8_t *b, NSUInteger length, NSUInteger offset, uint8_t *tag, NSUInteger *start, NSUInteger *end) {
  if (offset >= length || length - offset < 2) return NO;
  *tag = b[offset];
  NSUInteger i = offset + 1, size = b[i++];
  if (size & 0x80) {
    NSUInteger count = size & 0x7f;
    if (count == 0 || count > 4 || count > length - i) return NO;
    size = 0;
    for (NSUInteger k = 0; k < count; k++) size = (size << 8) | b[i++];
  }
  if (size > length - i) return NO;
  *start = i; *end = i + size; return YES;
}
// The certificate's SubjectPublicKeyInfo exactly as encoded: Certificate, tbsCertificate,
// then [0] version (optional), serial, signature, issuer, validity, subject, and the key.
NSData *STMSubjectPublicKeyInfo(NSData *der) {
  const uint8_t *b = (const uint8_t *)der.bytes; uint8_t tag; NSUInteger start, end;
  if (!der.length || !DERElement(b, der.length, 0, &tag, &start, &end) || tag != 0x30) return nil;
  NSUInteger limit = end;
  if (!DERElement(b, limit, start, &tag, &start, &end) || tag != 0x30) return nil;
  limit = end; NSUInteger at = start;
  if (!DERElement(b, limit, at, &tag, &start, &end)) return nil;
  if (tag == 0xa0) at = end;
  for (int field = 0; field < 5; field++) {
    if (!DERElement(b, limit, at, &tag, &start, &end)) return nil;
    at = end;
  }
  NSUInteger from = at;
  if (!DERElement(b, limit, at, &tag, &start, &end) || tag != 0x30) return nil;
  return [der subdataWithRange:NSMakeRange(from, end - from)];
}
BOOL STMPinnedTrust(NSURLAuthenticationChallenge *challenge, NSDictionary *r,
                    void (^done)(NSURLSessionAuthChallengeDisposition, NSURLCredential *)) {
  NSString *keyPin = [r isKindOfClass:NSDictionary.class] ? r[@"publicKeySha256"] : nil;
  NSString *pin = keyPin ?: ([r isKindOfClass:NSDictionary.class] ? r[@"certificateSha256"] : nil);
  if (!pin) { done(NSURLSessionAuthChallengePerformDefaultHandling, nil); return NO; }
  // A pinned companion is trusted only by its certificate or its public key, never any other way.
  SecTrustRef trust = challenge.protectionSpace.serverTrust;
  NSData *der = nil;
  if (trust && [challenge.protectionSpace.authenticationMethod isEqual:NSURLAuthenticationMethodServerTrust]) {
    CFArrayRef chain = SecTrustCopyCertificateChain(trust);
    SecCertificateRef leaf = chain && CFArrayGetCount(chain) > 0 ? (SecCertificateRef)CFArrayGetValueAtIndex(chain, 0) : NULL;
    der = leaf ? CFBridgingRelease(SecCertificateCopyData(leaf)) : nil;
    if (chain) CFRelease(chain);
  }
  NSURL *base = STMPairingBaseURL(r);
  // The protection space reports 0 for the scheme's default port.
  NSInteger expected = base.port ? base.port.integerValue : 443, actual = challenge.protectionSpace.port ?: 443;
  NSData *pinned = keyPin ? STMSubjectPublicKeyInfo(der) : der;
  BOOL same = base && pinned && actual == expected &&
    [challenge.protectionSpace.host caseInsensitiveCompare:base.host] == NSOrderedSame && [STMHash(pinned) isEqual:pin];
  if (same) { done(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialForTrust:trust]); return NO; }
  done(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil); return YES;
}
static BOOL ValidScopes(id value) {
  if (![value isKindOfClass:NSArray.class] || [value count]<2 || [value count]>10) return NO;
  NSSet *allowed=[NSSet setWithArray:@[@"generation:health",@"generation:create",@"projects:read",@"projects:write",@"captures:read",@"captures:import",@"prepared-jobs:read",@"prepared-jobs:prepare",@"prints:approve",@"printer-handoff:use"]];
  NSMutableSet *seen=[NSMutableSet new];
  for(id scope in value){if(![scope isKindOfClass:NSString.class]||![allowed containsObject:scope]||[seen containsObject:scope])return NO;[seen addObject:scope];}
  return [seen containsObject:@"generation:health"];
}
// A v2 record keeps its address list and public-key pin; its baseUrl and activeUrl are listed addresses.
static BOOL ValidAddresses(NSDictionary *r) {
  if (!r[@"publicKeySha256"]) return !r[@"addresses"] && !r[@"activeUrl"];
  NSArray *addresses = STMPinnedAddresses(r[@"addresses"], r[@"publicKeySha256"]);
  return !r[@"certificateSha256"] && ValidPin(r[@"publicKeySha256"]) && [addresses containsObject:r[@"baseUrl"]] &&
    (!r[@"activeUrl"] || [addresses containsObject:r[@"activeUrl"]]);
}
static BOOL ValidRecord(NSDictionary *r) {
  return [r isKindOfClass:NSDictionary.class] && (!r[@"certificateSha256"] || ValidPin(r[@"certificateSha256"])) && ValidAddresses(r) && STMPairingBaseURL(r) &&
    [r[@"protocolVersion"] isEqual:@"0.1.0"] && [r[@"deviceId"] isKindOfClass:NSString.class] && [[NSUUID alloc] initWithUUIDString:r[@"deviceId"]] &&
    Matches(r[@"token"], @"[A-Za-z0-9_-]{43}") && [r[@"expiresAt"] isKindOfClass:NSNumber.class] &&
    [r[@"expiresAt"] doubleValue] > 0 && ValidScopes(r[@"scopes"]);
}
BOOL STMSamePairing(NSDictionary *a, NSDictionary *b) {
  if (![a isKindOfClass:NSDictionary.class] || ![b isKindOfClass:NSDictionary.class]) return NO;
  // activeUrl is left out on purpose: answering on another of the Mac's addresses is the same pairing.
  for (NSString *key in @[@"baseUrl", @"deviceId", @"token", @"protocolVersion", @"certificateSha256", @"publicKeySha256", @"addresses"]) {
    id x = a[key], y = b[key];
    if (x != y && ![x isEqual:y]) return NO;
  }
  return YES;
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
    @"baseUrl":r[@"baseUrl"], @"deviceId":r[@"deviceId"], @"expiresAt":r[@"expiresAt"], @"fixture":@(STMFixtureURL(STMPairingBaseURL(r))) };
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
// Pairing link v2: the addresses not yet tried, the record for the current attempt,
// and the failure to report if none answers.
@property NSArray<NSString *> *remaining;
@property NSDictionary *active;
@property NSString *failure;
@property NSString *pairCode;
@property NSString *pairName;
@property NSString *installationKey;
@property NSInteger status;
@property BOOL pairing;
// A credential refresh: the reply only moves the stored expiry on.
@property BOOL refreshing;
@property BOOL pinRejected;
@property (copy) RCTPromiseResolveBlock resolve;
@property (copy) RCTPromiseRejectBlock reject;
@end
@implementation CompanionPairing
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (void)retire {
  [self.task cancel]; self.task = nil; [self.session invalidateAndCancel]; self.session = nil;
}
- (void)clear {
  [self retire];
  self.bytes = nil; self.pending = nil; self.snapshot = nil; self.resolve = nil; self.reject = nil;
  self.remaining = nil; self.active = nil; self.failure = nil; self.pairCode = nil; self.pairName = nil; self.installationKey = nil;
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
RCT_REMAP_METHOD(deviceName, deviceNameResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil; NSString *key = InstallationKey(&error);
  if (error) reject(@"secure-storage", @"Unlock this device and try again.", nil);
  else resolve(DeviceName(key));
}
RCT_REMAP_METHOD(setDeviceName, setDeviceName:(NSString *)name resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSString *trimmed = [name isKindOfClass:NSString.class] ? [name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] : nil;
  if (!Matches(trimmed, @"[^\\x00-\\x1f\\x7f]{1,80}")) { reject(@"invalid-device-name", @"Choose a name between 1 and 80 characters.", nil); return; }
  [NSUserDefaults.standardUserDefaults setObject:trimmed forKey:@"CounterpartDeviceName"];
  resolve(trimmed);
}
RCT_REMAP_METHOD(cancel, cancelResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) { [self fail:@"cancelled"]; resolve(nil); }
RCT_REMAP_METHOD(disconnect, disconnectResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [self fail:@"cancelled"];
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)Query());
  if (status != errSecSuccess && status != errSecItemNotFound) { reject(@"secure-storage", @"Pairing could not be removed. Unlock this device and retry.", nil); return; }
  [[NSNotificationCenter defaultCenter] postNotificationName:STMPairingChanged object:nil];
  resolve(@{ @"state":@"disconnected" });
}
- (void)start:(NSMutableURLRequest *)request resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  self.resolve = resolve; self.reject = reject; self.bytes = [NSMutableData new]; self.pinRejected = NO;
  NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  config.timeoutIntervalForRequest = 10; config.timeoutIntervalForResource = 15;
  config.URLCache = nil; config.HTTPShouldSetCookies = NO;
  self.session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:NSOperationQueue.mainQueue];
  self.task = [self.session dataTaskWithRequest:request]; [self.task resume];
}
- (BOOL)preparePairing:(RCTPromiseRejectBlock)reject {
  NSError *error = nil;
  self.installationKey = InstallationKey(&error);
  if (!error) self.snapshot = STMReadPairing(&error);
  if (!error) return YES;
  [self clear]; reject(@"secure-storage", @"Unlock this device and try again.", nil); return NO;
}
- (NSMutableURLRequest *)pairRequest:(NSURL *)base code:(NSString *)code name:(NSString *)name {
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[base URLByAppendingPathComponent:@"v1/pair"]];
  request.HTTPMethod = @"POST";
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{@"code":code, @"deviceName":name, @"installationKey":self.installationKey} options:0 error:nil];
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  // The previous token only goes to the same trusted Mac. It can adopt that
  // phone's legacy row; its public device id alone is never replacement proof.
  if (SameCompanion(self.snapshot, self.pending)) {
    [request setValue:[@"Bearer " stringByAppendingString:self.snapshot[@"token"]] forHTTPHeaderField:@"Authorization"];
    [request setValue:self.snapshot[@"deviceId"] forHTTPHeaderField:@"X-Scan-Device"];
  }
  return request;
}
RCT_REMAP_METHOD(pair, pairURL:(NSString *)baseUrl code:(NSString *)code deviceName:(NSString *)name certificateSha256:(NSString *)pin resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (self.task) { reject(@"busy", @"A connection check is already running.", nil); return; }
  BOOL pinned = [pin isKindOfClass:NSString.class];
  NSURL *url = pinned ? STMPinnedBaseURL(baseUrl, pin) : STMCompanionBaseURL(baseUrl);
  if (!url || !Matches(code, @"[A-Za-z0-9_-]{32}") || !Matches(name, @"[^\\x00-\\x1f\\x7f]{1,80}")) { reject(@"invalid-invitation", @"Check the companion address and pairing invitation.", nil); return; }
  if (![self preparePairing:reject]) return;
  self.pairing = YES; self.refreshing = NO;
  self.pending = pinned ? @{ @"baseUrl":url.absoluteString, @"certificateSha256":pin } : @{ @"baseUrl":url.absoluteString };
  NSMutableURLRequest *request = [self pairRequest:url code:code name:name];
  [self start:request resolve:resolve reject:reject];
}
RCT_REMAP_METHOD(pairAddresses, pairAddresses:(NSArray *)addresses code:(NSString *)code deviceName:(NSString *)name publicKeySha256:(NSString *)pin resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (self.task) { reject(@"busy", @"A connection check is already running.", nil); return; }
  NSArray *list = ValidPin(pin) ? STMPinnedAddresses(addresses, pin) : nil;
  if (!list || !Matches(code, @"[A-Za-z0-9_-]{32}") || !Matches(name, @"[^\\x00-\\x1f\\x7f]{1,80}")) { reject(@"invalid-invitation", @"Check the companion address and pairing invitation.", nil); return; }
  if (![self preparePairing:reject]) return;
  self.pairing = YES; self.refreshing = NO; self.resolve = resolve; self.reject = reject;
  self.remaining = list; self.pairCode = code; self.pairName = name;
  self.active = @{ @"addresses":list, @"publicKeySha256":pin };
  [self next];
}
RCT_REMAP_METHOD(check, checkResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (self.task) { reject(@"busy", @"A connection check is already running.", nil); return; }
  NSError *error = nil; NSDictionary *r = STMReadPairing(&error);
  if (error || !r || [r[@"expiresAt"] doubleValue] <= NSDate.date.timeIntervalSince1970*1000) { reject(error ? @"secure-storage" : @"pairing-required", @"Connect this device to a companion.", nil); return; }
  self.pairing = NO; self.refreshing = NO; self.snapshot = r; self.resolve = resolve; self.reject = reject;
  self.remaining = STMAttemptOrder(r); self.active = r;
  [self next];
}
// Starts the request for the next address: pairing at it, or checking the stored credential there.
- (void)next {
  NSString *address = self.remaining.firstObject;
  self.remaining = [self.remaining subarrayWithRange:NSMakeRange(1, self.remaining.count - 1)];
  NSMutableDictionary *record = [self.active mutableCopy];
  // Pairing: the answering address becomes baseUrl. Checking: only activeUrl moves, so the
  // companion keeps the same baseUrl (and local storage) whichever address answers.
  if (self.pairing) record[@"baseUrl"] = address;
  else if ([address isEqual:record[@"baseUrl"]]) [record removeObjectForKey:@"activeUrl"];
  else record[@"activeUrl"] = address;
  NSURL *base = STMPairingBaseURL(record);
  if (self.pairing) self.pending = record; else self.active = record;
  NSMutableURLRequest *request;
  if (self.pairing) {
    request = [self pairRequest:base code:self.pairCode name:self.pairName];
  } else {
    request = [NSMutableURLRequest requestWithURL:[base URLByAppendingPathComponent:@"healthz"]];
    [request setValue:[@"Bearer " stringByAppendingString:record[@"token"]] forHTTPHeaderField:@"Authorization"];
    [request setValue:record[@"deviceId"] forHTTPHeaderField:@"X-Scan-Device"];
  }
  [self start:request resolve:self.resolve reject:self.reject];
}
// Rolling refresh (POST /v1/auth/refresh, companion #147): the same token,
// valid for another full lifetime. No body; the token never reaches JS.
RCT_REMAP_METHOD(refresh, refreshResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (self.task) { reject(@"busy", @"A connection check is already running.", nil); return; }
  NSError *error = nil; NSDictionary *r = STMReadPairing(&error);
  if (error || !r || [r[@"expiresAt"] doubleValue] <= NSDate.date.timeIntervalSince1970*1000) { reject(error ? @"secure-storage" : @"pairing-required", @"Connect this device to a companion.", nil); return; }
  self.pairing = NO; self.refreshing = YES; self.snapshot = r;
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[STMPairingBaseURL(r) URLByAppendingPathComponent:@"v1/auth/refresh"]];
  request.HTTPMethod = @"POST"; request.HTTPBody = [NSData data];
  [request setValue:[@"Bearer " stringByAppendingString:r[@"token"]] forHTTPHeaderField:@"Authorization"];
  [request setValue:r[@"deviceId"] forHTTPHeaderField:@"X-Scan-Device"];
  [self start:request resolve:resolve reject:reject];
}
- (void)URLSession:(NSURLSession *)session didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completionHandler {
  if (STMPinnedTrust(challenge, self.pairing ? self.pending : (self.active ?: self.snapshot), completionHandler)) self.pinRejected = YES;
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
  if (error) {
    NSString *failure = self.pinRejected ? @"certificate-changed" : STMTransportError(error);
    // An unreachable address beats another server's certificate as the reason to report.
    if (!self.failure || [@[@"network", @"timeout"] containsObject:failure]) self.failure = failure;
    if (self.remaining.count && STMTryNextAddress(failure)) { [self retire]; [self next]; return; }
    [self fail:self.remaining.count ? failure : self.failure]; return;
  }
  if (self.status != 200) {
    NSString *code = self.status == 401 ? @"unauthorized" : self.status == 403 ? @"forbidden" : self.status == 429 ? @"rate-limited" : self.status >= 300 && self.status < 400 ? @"wrong-host" : @"unavailable";
    [self fail:code]; return;
  }
  id json = [NSJSONSerialization JSONObjectWithData:self.bytes options:0 error:nil];
  if (![json isKindOfClass:NSDictionary.class]) { [self fail:@"invalid-response"]; return; }
  NSDictionary *result;
  if (self.pairing) {
    NSMutableDictionary *r = [json mutableCopy];
    // The address, pin and address list come from the invitation, never the response.
    [r removeObjectsForKeys:@[@"certificateSha256", @"publicKeySha256", @"addresses", @"activeUrl"]];
    for (NSString *key in @[@"baseUrl", @"certificateSha256", @"publicKeySha256", @"addresses"])
      if (self.pending[key]) r[key] = self.pending[key];
    if (!ValidRecord(r) || [r[@"expiresAt"] doubleValue] <= NSDate.date.timeIntervalSince1970*1000 || [r[@"expiresAt"] doubleValue] > NSDate.date.timeIntervalSince1970*1000+31.0*86400000) { [self fail:@"invalid-response"]; return; }
    NSData *data = [NSJSONSerialization dataWithJSONObject:r options:0 error:nil];
    NSDictionary *attrs = @{(__bridge id)kSecValueData:data, (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly};
    OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)Query(), (__bridge CFDictionaryRef)attrs);
    if (status == errSecItemNotFound) { NSMutableDictionary *q = [Query() mutableCopy]; [q addEntriesFromDictionary:attrs]; status = SecItemAdd((__bridge CFDictionaryRef)q, NULL); }
    if (status != errSecSuccess) { [self fail:@"secure-storage"]; return; }
      [[NSNotificationCenter defaultCenter] postNotificationName:STMPairingChanged object:nil];
    result = STMPairingMetadata(r);
  } else if (self.refreshing) {
    NSError *readError = nil; NSDictionary *current = STMReadPairing(&readError);
    if (readError || ![current isEqual:self.snapshot]) { [self fail:@"pairing-changed"]; return; }
    // The same credential back, with a later expiry no more than one
    // lifetime away; only the expiry and scopes are taken from it.
    double now = NSDate.date.timeIntervalSince1970*1000;
    NSMutableDictionary *r = [current mutableCopy]; r[@"expiresAt"] = json[@"expiresAt"]; r[@"scopes"] = json[@"scopes"];
    if (![json[@"protocolVersion"] isEqual:current[@"protocolVersion"]] || ![json[@"deviceId"] isEqual:current[@"deviceId"]] ||
        ![json[@"token"] isEqual:current[@"token"]] || !ValidRecord(r) ||
        [r[@"expiresAt"] doubleValue] <= now || [r[@"expiresAt"] doubleValue] > now+31.0*86400000) { [self fail:@"invalid-response"]; return; }
    NSData *data = [NSJSONSerialization dataWithJSONObject:r options:0 error:nil];
    NSDictionary *attrs = @{(__bridge id)kSecValueData:data, (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly};
    OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)Query(), (__bridge CFDictionaryRef)attrs);
    if (status == errSecItemNotFound) { [self fail:@"pairing-changed"]; return; }
    if (status != errSecSuccess) { [self fail:@"secure-storage"]; return; }
    // Still the same pairing (STMSamePairing), so no STMPairingChanged:
    // uploads and checks in flight carry on.
    result = STMPairingMetadata(r);
  } else {
    NSError *readError = nil; NSDictionary *current = STMReadPairing(&readError);
    if (readError || ![current isEqual:self.snapshot]) { [self fail:@"pairing-changed"]; return; }
    if (![json[@"protocolVersion"] isEqual:@"0.1.0"]) { [self fail:@"invalid-response"]; return; }
    // Another address answered: keep it first for this and every later request.
    if (![self.active isEqual:current]) {
      NSData *data = [NSJSONSerialization dataWithJSONObject:self.active options:0 error:nil];
      NSDictionary *attrs = @{(__bridge id)kSecValueData:data, (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly};
      if (!ValidRecord(self.active) || SecItemUpdate((__bridge CFDictionaryRef)Query(), (__bridge CFDictionaryRef)attrs) != errSecSuccess) { [self fail:@"secure-storage"]; return; }
      // Another of the Mac's addresses is still the same pairing (STMSamePairing): no STMPairingChanged.
      current = self.active;
    }
    result = STMPairingMetadata(current);
  }
  RCTPromiseResolveBlock resolve = self.resolve; [self clear]; resolve(result);
}
- (void)invalidate { dispatch_async(dispatch_get_main_queue(), ^{ [self fail:@"cancelled"]; }); }
@end
