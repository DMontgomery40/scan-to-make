// Exercise production native validation/metadata/disconnect with an isolated
// Keychain API double. Actual Keychain persistence is verified in Simulator.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
static NSData *stored;
static OSStatus keychainStatus = errSecSuccess;
static OSStatus Read(CFDictionaryRef query, CFTypeRef *result) {
  if (keychainStatus != errSecSuccess) return keychainStatus;
  if (!stored) return errSecItemNotFound;
  *result = CFBridgingRetain(stored); return errSecSuccess;
}
static OSStatus Delete(CFDictionaryRef query) {
  if (keychainStatus != errSecSuccess) return keychainStatus;
  stored = nil; return errSecSuccess;
}
#define SecItemCopyMatching Read
#define SecItemDelete Delete
#import "../../modules/local-project-storage/ios/CompanionPairing.mm"
// A protection space carrying a chosen server trust, as URLSession would hand it over.
@interface STMTestSpace : NSURLProtectionSpace
@property (assign) SecTrustRef trustRef;
@end
@implementation STMTestSpace
- (SecTrustRef)serverTrust { return self.trustRef; }
@end
static NSURLSessionAuthChallengeDisposition Decide(NSString *host, NSInteger port, NSString *method, SecTrustRef trust, NSDictionary *record, BOOL *rejected) {
  STMTestSpace *space = [[STMTestSpace alloc] initWithHost:host port:port protocol:NSURLProtectionSpaceHTTPS realm:nil authenticationMethod:method];
  space.trustRef = trust;
  NSURLAuthenticationChallenge *challenge = [[NSURLAuthenticationChallenge alloc] initWithProtectionSpace:space proposedCredential:nil previousFailureCount:0 failureResponse:nil error:nil sender:(id<NSURLAuthenticationChallengeSender>)[NSObject new]];
  __block NSURLSessionAuthChallengeDisposition decided = (NSURLSessionAuthChallengeDisposition)-1;
  *rejected = STMPinnedTrust(challenge, record, ^(NSURLSessionAuthChallengeDisposition d, NSURLCredential *c) { decided = d; });
  return decided;
}
int main(int argc, char **argv) { @autoreleasepool {
  NSCAssert(STMCompanionBaseURL(@"https://host.example.ts.net") != nil, @"valid host");
  for (NSString *bad in @[@"http://host.example.ts.net", @"https://host.example.ts.net:443", @"https://user@host.example.ts.net", @"https://host.example.ts.net/path", @"https://host.example.ts.net?code=x", @"https://host.example.ts.net#x", @"https://evil.test", @"http://127.0.0.1:9078"]) {
    NSCAssert(!STMCompanionBaseURL(bad), @"fail closed host");
  }
  NSCAssert([STMTransportError([NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorServerCertificateUntrusted userInfo:nil]) isEqual:@"certificate"], @"certificate recovery");
  NSCAssert([STMTransportError([NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorTimedOut userInfo:nil]) isEqual:@"timeout"], @"timeout recovery");
  NSMutableDictionary *r = [@{@"baseUrl":@"https://host.example.ts.net", @"protocolVersion":@"0.1.0", @"deviceId":NSUUID.UUID.UUIDString, @"token":[@"" stringByPaddingToLength:43 withString:@"x" startingAtIndex:0], @"expiresAt":@(NSDate.date.timeIntervalSince1970*1000+60000), @"scopes":@[@"generation:health",@"generation:create"]} mutableCopy];
  stored = [NSJSONSerialization dataWithJSONObject:r options:0 error:nil];
  CompanionPairing *bridge = [CompanionPairing new];
  __block BOOL safe = NO;
  [bridge statusResolve:^(id result) { safe = [result[@"state"] isEqual:@"paired"] && result[@"token"] == nil && result[@"scopes"] == nil; } reject:^(NSString *c, NSString *m, NSError *e) { abort(); }];
  NSCAssert(safe, @"metadata excludes secrets");
  keychainStatus = errSecInteractionNotAllowed;
  __block BOOL failed = NO;
  [bridge disconnectResolve:^(id x) { abort(); } reject:^(NSString *c, NSString *m, NSError *e) { failed = [c isEqual:@"secure-storage"]; }];
  NSCAssert(failed && stored != nil, @"failed secure delete must not claim disconnect");
  keychainStatus = errSecSuccess;
  [bridge disconnectResolve:^(id x) { NSCAssert([x[@"state"] isEqual:@"disconnected"], @"disconnect"); } reject:^(NSString *c, NSString *m, NSError *e) { abort(); }];
  NSCAssert(stored == nil, @"credential deleted");
  r[@"deviceId"] = @42; stored = [NSJSONSerialization dataWithJSONObject:r options:0 error:nil];
  NSError *error = nil; NSCAssert(!STMReadPairing(&error) && error, @"corrupt credential fails closed");
  // Pinned companions: only addresses iOS lets a private certificate use.
  NSString *pin = [@"" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0];
  for (NSString *ok in @[@"https://192.168.1.20:9077", @"https://[fd00::1]:9077", @"https://mac.local", @"https://mac"]) NSCAssert(STMPinnedBaseURL(ok, pin), @"pinned host allowed");
  for (NSString *bad in @[@"http://192.168.1.20:9077", @"https://mac.example.com", @"https://192.168.1.20/path", @"https://user@192.168.1.20"]) NSCAssert(!STMPinnedBaseURL(bad, pin), @"pinned host refused");
  NSCAssert(!STMPinnedBaseURL(@"https://192.168.1.20", @"ABC"), @"malformed pin refused");
  NSCAssert(!STMPairingBaseURL(@{@"baseUrl":@"https://192.168.1.20:9077"}), @"unpinned LAN address refused");
  // Trust decisions against a real self-signed certificate.
  NSData *der = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[1]]];
  SecCertificateRef cert = SecCertificateCreateWithData(NULL, (__bridge CFDataRef)der);
  SecTrustRef trust = NULL; SecPolicyRef policy = SecPolicyCreateSSL(true, CFSTR("192.168.1.20"));
  NSCAssert(cert && SecTrustCreateWithCertificates(cert, policy, &trust) == errSecSuccess, @"test trust");
  NSDictionary *pinned = @{@"baseUrl":@"https://192.168.1.20", @"certificateSha256":STMHash(der)};
  NSDictionary *wrong = @{@"baseUrl":@"https://192.168.1.20", @"certificateSha256":pin};
  NSString *server = NSURLAuthenticationMethodServerTrust;
  BOOL rejected = NO;
  NSCAssert(Decide(@"192.168.1.20", 0, server, trust, pinned, &rejected) == NSURLSessionAuthChallengeUseCredential && !rejected, @"pinned certificate on the default port");
  NSCAssert(Decide(@"192.168.1.20", 443, server, trust, pinned, &rejected) == NSURLSessionAuthChallengeUseCredential && !rejected, @"pinned certificate on 443");
  NSCAssert(Decide(@"192.168.1.20", 443, server, trust, wrong, &rejected) == NSURLSessionAuthChallengeCancelAuthenticationChallenge && rejected, @"different certificate refused");
  NSCAssert(Decide(@"192.168.1.21", 443, server, trust, pinned, &rejected) == NSURLSessionAuthChallengeCancelAuthenticationChallenge && rejected, @"other host refused");
  NSCAssert(Decide(@"192.168.1.20", 9077, server, trust, pinned, &rejected) == NSURLSessionAuthChallengeCancelAuthenticationChallenge && rejected, @"other port refused");
  NSCAssert(Decide(@"192.168.1.20", 443, NSURLAuthenticationMethodClientCertificate, trust, pinned, &rejected) == NSURLSessionAuthChallengeCancelAuthenticationChallenge && rejected, @"pinned session fails closed");
  NSCAssert(Decide(@"host.example.ts.net", 443, server, trust, @{@"baseUrl":@"https://host.example.ts.net"}, &rejected) == NSURLSessionAuthChallengePerformDefaultHandling && !rejected, @"unpinned keeps system trust");
  // Pairing link v2: trust by public key, on any listed address.
  NSString *keyPin = [NSString stringWithUTF8String:argv[2]];
  NSCAssert([STMHash(STMSubjectPublicKeyInfo(der)) isEqual:keyPin], @"RSA SubjectPublicKeyInfo matches OpenSSL");
  NSData *ecDer = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[3]]];
  NSCAssert([STMHash(STMSubjectPublicKeyInfo(ecDer)) isEqual:[NSString stringWithUTF8String:argv[4]]], @"EC SubjectPublicKeyInfo matches OpenSSL");
  NSUInteger cuts[] = {0, 1, 4, der.length / 2, der.length - 1};
  for (NSUInteger i = 0; i < sizeof cuts / sizeof *cuts; i++)
    NSCAssert(!STMSubjectPublicKeyInfo([der subdataWithRange:NSMakeRange(0, cuts[i])]), @"truncated certificate refused");
  NSCAssert(!STMSubjectPublicKeyInfo([@"not a certificate" dataUsingEncoding:NSUTF8StringEncoding]), @"garbage refused");
  NSArray *addresses = @[@"https://192.168.1.20:9077", @"https://mac.local:9077", @"https://100.101.102.103:9077"];
  NSDictionary *keyed = @{@"baseUrl":@"https://192.168.1.20:9077", @"publicKeySha256":keyPin, @"addresses":addresses};
  NSCAssert(Decide(@"192.168.1.20", 9077, server, trust, keyed, &rejected) == NSURLSessionAuthChallengeUseCredential && !rejected, @"pinned key on its address");
  NSCAssert(Decide(@"192.168.1.20", 9077, server, trust, @{@"baseUrl":@"https://192.168.1.20:9077", @"publicKeySha256":pin, @"addresses":addresses}, &rejected) == NSURLSessionAuthChallengeCancelAuthenticationChallenge && rejected, @"other key refused");
  NSCAssert(Decide(@"mac.local", 9077, server, trust, keyed, &rejected) == NSURLSessionAuthChallengeCancelAuthenticationChallenge && rejected, @"only the address being tried");
  NSMutableDictionary *atLocal = [keyed mutableCopy]; atLocal[@"activeUrl"] = @"https://mac.local:9077";
  NSCAssert(Decide(@"mac.local", 9077, server, trust, atLocal, &rejected) == NSURLSessionAuthChallengeUseCredential && !rejected, @"same key on the next address");
  NSCAssert([STMPinnedAddresses(addresses, keyPin) isEqual:addresses], @"address list kept in order");
  NSMutableArray *nine = [NSMutableArray new]; for (int i = 1; i <= 9; i++) [nine addObject:[NSString stringWithFormat:@"https://192.168.1.%d:9077", i]];
  for (id bad in @[@[], nine, @[@"https://mac.local:9077", @"https://MAC.local:9077"], @[@"https://mac.local:9077/"], @[@"https://host.example.ts.net"], @[@"http://192.168.1.20:9077"], @[@42], @"https://mac.local"])
    NSCAssert(!STMPinnedAddresses(bad, keyPin), @"address list refused");
  NSCAssert(!STMPinnedAddresses(addresses, @"ABC"), @"malformed key pin refused");
  NSCAssert([STMAttemptOrder(atLocal) isEqual:(@[@"https://mac.local:9077", @"https://192.168.1.20:9077", @"https://100.101.102.103:9077"])], @"last good address first");
  // Requests follow activeUrl; baseUrl, which names the companion for every bridge's local state, never moves.
  NSCAssert([STMPairingBaseURL(atLocal).absoluteString isEqual:@"https://mac.local:9077"] && [atLocal[@"baseUrl"] isEqual:@"https://192.168.1.20:9077"], @"active address used, base kept");
  NSCAssert([STMAttemptOrder(pinned) isEqual:(@[@"https://192.168.1.20"])], @"v1 record has one address");
  NSMutableDictionary *v1Active = [pinned mutableCopy]; v1Active[@"activeUrl"] = @"https://10.0.0.9";
  NSMutableDictionary *v1Bad = [r mutableCopy]; [v1Bad addEntriesFromDictionary:v1Active]; v1Bad[@"deviceId"] = NSUUID.UUID.UUIDString;
  stored = [NSJSONSerialization dataWithJSONObject:v1Bad options:0 error:nil];
  error = nil; NSCAssert(!STMReadPairing(&error) && error, @"v1 record never has an active address");
  for (NSString *next in @[@"network", @"timeout", @"certificate", @"certificate-changed"]) NSCAssert(STMTryNextAddress(next), @"move on");
  for (NSString *stop in @[@"unauthorized", @"forbidden", @"rate-limited", @"unavailable", @"invalid-response", @"wrong-host"]) NSCAssert(!STMTryNextAddress(stop), @"the companion answered");
  // A stored v2 record: its baseUrl must be one of its addresses, and it has no certificate pin.
  NSMutableDictionary *record = [r mutableCopy]; record[@"deviceId"] = NSUUID.UUID.UUIDString;
  [record addEntriesFromDictionary:keyed];
  stored = [NSJSONSerialization dataWithJSONObject:record options:0 error:nil];
  error = nil; NSCAssert(STMReadPairing(&error) && !error, @"v2 record valid");
  NSCAssert([STMPairingBaseURL(record).absoluteString isEqual:@"https://192.168.1.20:9077"], @"v2 base URL");
  NSMutableDictionary *moved = [record mutableCopy]; moved[@"activeUrl"] = @"https://100.101.102.103:9077";
  stored = [NSJSONSerialization dataWithJSONObject:moved options:0 error:nil];
  error = nil; NSCAssert(STMReadPairing(&error) && !error, @"v2 record with an active address valid");
  for (NSDictionary *change in @[@{@"baseUrl":@"https://10.0.0.9:9077"}, @{@"activeUrl":@"https://10.0.0.9:9077"}, @{@"certificateSha256":pin}, @{@"addresses":@[@"https://mac.example.com"]}, @{@"publicKeySha256":@"x"}]) {
    NSMutableDictionary *bad = [record mutableCopy]; [bad addEntriesFromDictionary:change];
    stored = [NSJSONSerialization dataWithJSONObject:bad options:0 error:nil];
    error = nil; NSCAssert(!STMReadPairing(&error) && error, @"invalid v2 record refused");
  }
  NSCAssert(!STMPinnedAddresses(nil, keyPin), @"missing list refused");
  // Answering on another listed address, or a renewed expiry, is the same pairing; another key or list is not.
  NSMutableDictionary *renewed = [moved mutableCopy]; renewed[@"expiresAt"] = @([record[@"expiresAt"] doubleValue] + 1000);
  NSCAssert(STMSamePairing(record, moved) && STMSamePairing(record, renewed), @"active address and renewal keep the pairing");
  for (NSDictionary *change in @[@{@"publicKeySha256":pin}, @{@"addresses":@[@"https://192.168.1.20:9077"]}, @{@"token":[@"" stringByPaddingToLength:43 withString:@"y" startingAtIndex:0]}]) {
    NSMutableDictionary *other = [record mutableCopy]; [other addEntriesFromDictionary:change];
    NSCAssert(!STMSamePairing(record, other), @"another key, address list or token is another pairing");
  }
  stored = nil;
  CFRelease(trust); CFRelease(policy); CFRelease(cert);
  puts("PASS native: certificate pin trust (match, default port, other certificate/host/port, fail closed, unpinned default)");
  puts("PASS native: public-key pin (RSA and EC SubjectPublicKeyInfo = OpenSSL, other key/address refused, truncated DER refused), v2 address list, attempt order, fallback rule, v2 record validation");
  puts("PASS native: exact HTTPS host validation, certificate/timeout recovery, secret-free metadata, failed delete preservation, disconnect, corrupt credential rejection");
} }
