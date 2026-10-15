#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <CommonCrypto/CommonDigest.h>
#import <UIKit/UIKit.h>
#import "ArtifactFiles.h"
#import "CompanionPairing.h"
#import <TargetConditionals.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

static const NSUInteger STL_LIMIT = 32 * 1024 * 1024;
static const NSUInteger RESPONSE_LIMIT = ((32 * 1024 * 1024 + 2) / 3) * 4 + 256 * 1024 + 4096;
NSString *STMHash(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString new];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
  return hex;
}
NSURL *STMArtifactURL(NSString *digest) {
  if (![[NSPredicate predicateWithFormat:@"SELF MATCHES %@", @"[a-f0-9]{64}"] evaluateWithObject:digest]) return nil;
  NSURL *root = [[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];
  return [[root URLByAppendingPathComponent:@"Artifacts" isDirectory:YES] URLByAppendingPathComponent:[digest stringByAppendingString:@".stl"]];
}
NSData *STMVerifiedArtifact(NSString *digest, NSNumber *length, NSError **error) {
  NSURL *url = STMArtifactURL(digest);
  if (!url || length.doubleValue < 1 || length.doubleValue > STL_LIMIT || length.doubleValue != length.unsignedIntegerValue) return nil;
  NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:url.path error:error];
  if (![attrs[NSFileType] isEqual:NSFileTypeRegular] || [attrs[NSFileSize] unsignedIntegerValue] != length.unsignedIntegerValue) return nil;
  // A bounded private snapshot is rehashed at every render/share/reopen boundary.
  int fd = open(url.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return nil;
  NSMutableData *data = [NSMutableData dataWithLength:length.unsignedIntegerValue];
  NSUInteger offset = 0;
  while (offset < data.length) { ssize_t n = read(fd, (char *)data.mutableBytes + offset, data.length - offset); if (n <= 0) { close(fd); return nil; } offset += n; }
  char extra; ssize_t tail = read(fd, &extra, 1); close(fd);
  if (tail != 0 || ![STMHash(data) isEqualToString:digest]) return nil;
  return data;
}

@interface ArtifactBridge : NSObject <RCTBridgeModule, NSURLSessionDataDelegate>
@property NSURLSession *session;
@property NSURLSessionDataTask *task;
@property NSMutableData *response;
@property NSInteger status;
@property NSDictionary *pairingSnapshot;
@property (copy) RCTPromiseResolveBlock resolve;
@property (copy) RCTPromiseRejectBlock reject;
@end
@implementation ArtifactBridge
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (instancetype)init { if ((self = [super init])) { [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(pairingChanged:) name:STMPairingChanged object:nil]; } return self; }
- (void)pairingChanged:(NSNotification *)note { [self failNetwork:@"pairing-changed" message:@"Companion pairing changed. Your project is unchanged."]; }
- (void)dealloc { [[NSNotificationCenter defaultCenter] removeObserver:self]; }
- (void)failNetwork:(NSString *)code message:(NSString *)message {
  RCTPromiseRejectBlock reject = self.reject;
  self.resolve = nil; self.reject = nil; self.response = nil;
  [self.task cancel]; self.task = nil; [self.session invalidateAndCancel]; self.session = nil;
  if (reject) reject(code, message, nil);
}
RCT_REMAP_METHOD(generate, generateBody:(NSString *)body resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (self.task) { reject(@"busy", @"A generation request is already running.", nil); return; }
  NSData *request = [body dataUsingEncoding:NSUTF8StringEncoding];
  if (request.length > 256 * 1024) { reject(@"payload-too-large", @"Project request is too large.", nil); return; }
  NSError *pairingError = nil; NSDictionary *pairing = STMReadPairing(&pairingError);
  if (pairingError) { reject(@"secure-storage", @"Stored pairing could not be read. Unlock the device and retry.", nil); return; }
  NSURL *base = pairing ? STMCompanionBaseURL(pairing[@"baseUrl"]) : nil;
  if (pairing && [pairing[@"expiresAt"] doubleValue] <= NSDate.date.timeIntervalSince1970*1000) { reject(@"pairing-required", @"Pairing expired. Connect this device again.", nil); return; }
#if TARGET_OS_SIMULATOR
  // Existing same-Mac developer path only; never a remote authentication fallback.
  if (!pairing && STMLocalGenerationAllowed()) base = [NSURL URLWithString:@"http://127.0.0.1:9077"];
#endif
  if (!base) { reject(@"pairing-required", @"Connect to your companion before generating a design.", nil); return; }
  self.pairingSnapshot = pairing;
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[base URLByAppendingPathComponent:@"v1/generate"]];
  if (pairing) {
    [req setValue:[@"Bearer " stringByAppendingString:pairing[@"token"]] forHTTPHeaderField:@"Authorization"];
    [req setValue:pairing[@"deviceId"] forHTTPHeaderField:@"X-Scan-Device"];
  }
  req.HTTPMethod = @"POST"; req.HTTPBody = request; [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  config.timeoutIntervalForRequest = 35; config.timeoutIntervalForResource = 40;
  config.URLCache = nil; config.HTTPShouldSetCookies = NO;
  self.resolve = resolve; self.reject = reject; self.response = [NSMutableData new];
  self.session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:[NSOperationQueue mainQueue]];
  self.task = [self.session dataTaskWithRequest:req]; [self.task resume];
}
RCT_REMAP_METHOD(cancel, cancelResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [self failNetwork:@"cancelled" message:@"Generation cancelled."]; resolve(nil);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request completionHandler:(void (^)(NSURLRequest *))completionHandler { completionHandler(nil); }
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  if (task != self.task) { completionHandler(NSURLSessionResponseCancel); return; }
  if (response.expectedContentLength > (long long)RESPONSE_LIMIT) { completionHandler(NSURLSessionResponseCancel); [self failNetwork:@"payload-too-large" message:@"The generated response is too large."]; return; }
  self.status = [(NSHTTPURLResponse *)response statusCode]; completionHandler(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  if (task != self.task) return;
  if (data.length > RESPONSE_LIMIT - self.response.length) { [self failNetwork:@"payload-too-large" message:@"The generated response exceeded the receive limit."]; return; }
  [self.response appendData:data];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  if (task != self.task) return;
  if (error) { [self failNetwork:STMTransportError(error) message:@"The companion could not complete the request."]; return; }
  NSError *readError = nil; NSDictionary *current = STMReadPairing(&readError);
  if (readError || (self.pairingSnapshot ? ![current isEqual:self.pairingSnapshot] : current != nil)) { [self failNetwork:@"pairing-changed" message:@"Companion pairing changed. Your project is unchanged."]; return; }
  if (self.status == 401 || self.status == 403 || (self.status >= 300 && self.status < 400)) { [self failNetwork:self.status == 401 ? @"unauthorized" : self.status == 403 ? @"forbidden" : @"wrong-host" message:@"Companion authorization needs attention."]; return; }
  NSString *body = [[NSString alloc] initWithData:self.response encoding:NSUTF8StringEncoding];
  RCTPromiseResolveBlock resolve = self.resolve;
  self.task = nil; self.response = nil; self.resolve = nil; self.reject = nil;
  [self.session finishTasksAndInvalidate]; self.session = nil;
  resolve(@{@"status":@(self.status), @"body":body ?: @""});
}
RCT_REMAP_METHOD(hashBase64, hashBase64:(NSString *)encoded resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    if (encoded.length > ((STL_LIMIT + 2) / 3) * 4) { reject(@"invalid-bytes", @"Artifact is too large.", nil); return; }
    NSData *bytes = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
    if (!bytes || bytes.length > STL_LIMIT) { reject(@"invalid-bytes", @"Invalid artifact bytes.", nil); return; }
    resolve(STMHash(bytes));
  });
}
RCT_REMAP_METHOD(cache, cacheBase64:(NSString *)encoded digest:(NSString *)digest length:(NSNumber *)length resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSData *bytes = encoded.length <= ((STL_LIMIT + 2) / 3) * 4 ? [[NSData alloc] initWithBase64EncodedString:encoded options:0] : nil;
    NSURL *url = STMArtifactURL(digest);
    if (!url || bytes.length != length.unsignedIntegerValue || bytes.length < 1 || bytes.length > STL_LIMIT || ![STMHash(bytes) isEqualToString:digest]) { reject(@"invalid-bytes", @"Artifact verification failed.", nil); return; }
    NSFileManager *fm = [NSFileManager defaultManager]; NSError *error = nil;
    NSURL *directory = [url URLByDeletingLastPathComponent];
    if (![fm createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:&error]) { reject(@"cache-error", @"The design file could not be saved.", error); return; }
    BOOL damaged = [fm fileExistsAtPath:url.path] && !STMVerifiedArtifact(digest, length, &error);
    if (!damaged && [fm fileExistsAtPath:url.path]) { resolve(url.path); return; }
    NSURL *temp = [directory URLByAppendingPathComponent:[NSUUID.UUID.UUIDString stringByAppendingString:@".tmp"]];
    int fd = open(temp.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL, 0600);
    BOOL ok = fd >= 0;
    NSUInteger offset = 0;
    while (ok && offset < bytes.length) { ssize_t n = write(fd, (const char *)bytes.bytes + offset, bytes.length - offset); if (n <= 0) ok = NO; else offset += n; }
    if (ok) ok = fsync(fd) == 0;
    if (fd >= 0) close(fd);
    if (ok) {
      chmod(temp.fileSystemRepresentation, 0444);
      if (damaged) {
        // Explicit regeneration may replace a damaged entry only with newly verified
        // bytes of the same digest. Preserve the old inode for diagnosis first.
        NSURL *quarantine = [directory URLByAppendingPathComponent:[NSUUID.UUID.UUIDString stringByAppendingString:@".damaged"]];
        ok = link(url.fileSystemRepresentation, quarantine.fileSystemRepresentation) == 0;
        if (ok) ok = rename(temp.fileSystemRepresentation, url.fileSystemRepresentation) == 0;
      } else {
        ok = link(temp.fileSystemRepresentation, url.fileSystemRepresentation) == 0 || STMVerifiedArtifact(digest, length, &error) != nil;
      }
    }
    unlink(temp.fileSystemRepresentation);
    if (ok) {
      int directoryFd = open(directory.fileSystemRepresentation, O_RDONLY);
      ok = directoryFd >= 0 && fsync(directoryFd) == 0;
      if (directoryFd >= 0) close(directoryFd);
    }
    if (!ok) { reject(@"cache-error", @"The design file could not be saved.", error); return; }
    resolve(url.path);
  });
}
RCT_REMAP_METHOD(verifyCache, verifyDigest:(NSString *)digest length:(NSNumber *)length resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil;
    if (!STMVerifiedArtifact(digest, length, &error)) { reject(@"cache-invalid", @"The design file is missing or damaged. Generate a new preview before continuing.", error); return; }
    resolve(STMArtifactURL(digest).path);
  });
}
RCT_REMAP_METHOD(share, shareDigest:(NSString *)digest length:(NSNumber *)length name:(NSString *)name resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil; NSData *bytes = STMVerifiedArtifact(digest, length, &error);
    if (!bytes) { reject(@"cache-invalid", @"The design file is missing or damaged.", error); return; }
    NSURL *directory = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString] isDirectory:YES];
    [[NSFileManager defaultManager] createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:&error];
    // No caller path or mesh serialization: publish exactly the verified snapshot.
    NSString *safeName = [[name componentsSeparatedByCharactersInSet:[[NSCharacterSet alphanumericCharacterSet] invertedSet]] componentsJoinedByString:@"-"];
    NSURL *file = [directory URLByAppendingPathComponent:[safeName stringByAppendingString:@".stl"]];
    if (![bytes writeToURL:file options:NSDataWritingWithoutOverwriting error:&error]) { reject(@"export-error", @"The STL copy could not be created.", error); return; }
    dispatch_async(dispatch_get_main_queue(), ^{
      UIViewController *presenter = RCTPresentedViewController();
      if (!presenter || presenter.presentedViewController) { reject(@"export-error", @"Close the current sheet and try again.", nil); return; }
      UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:@[file] applicationActivities:nil];
      sheet.popoverPresentationController.sourceView = presenter.view;
      sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(presenter.view.bounds), CGRectGetMidY(presenter.view.bounds), 1, 1);
      sheet.completionWithItemsHandler = ^(UIActivityType type, BOOL completed, NSArray *items, NSError *shareError) {
        if (shareError) reject(@"export-error", @"The share action failed.", shareError);
        else resolve(@{@"completed":@(completed), @"path":file.path, @"sha256":digest, @"byteLength":length});
      };
      [presenter presentViewController:sheet animated:YES completion:nil];
    });
  });
}
- (void)invalidate { dispatch_async(dispatch_get_main_queue(), ^{ [self failNetwork:@"cancelled" message:@"Generation cancelled."]; }); }
@end
