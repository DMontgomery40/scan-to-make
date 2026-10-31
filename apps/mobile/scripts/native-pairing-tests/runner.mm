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
  CFRelease(trust); CFRelease(policy); CFRelease(cert);
  puts("PASS native: certificate pin trust (match, default port, other certificate/host/port, fail closed, unpinned default)");
  puts("PASS native: exact HTTPS host validation, certificate/timeout recovery, secret-free metadata, failed delete preservation, disconnect, corrupt credential rejection");
} }
