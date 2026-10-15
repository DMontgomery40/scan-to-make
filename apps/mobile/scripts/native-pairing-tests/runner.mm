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
int main() { @autoreleasepool {
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
  puts("PASS native: exact HTTPS host validation, certificate/timeout recovery, secret-free metadata, failed delete preservation, disconnect, corrupt credential rejection");
} }
