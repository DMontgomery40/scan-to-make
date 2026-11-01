#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <PhotosUI/PhotosUI.h>
#import <SceneKit/SceneKit.h>
#import <ModelIO/ModelIO.h>
#import <SceneKit/ModelIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import "CompanionPairing.h"

// Objects on the paired Mac (/v1/objects). Pairing credentials stay native and
// every request is pinned like the other bridges. Files go straight from the
// capture folder, the photo picker or the camera to the Mac, so JavaScript
// never handles file paths; downloads come back as cached file URIs.

static NSString *const STMObjectsUUID = @"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
static NSUInteger const STMObjectsScanLimit = 64 * 1024 * 1024;
static NSUInteger const STMObjectsPhotoLimit = 25 * 1024 * 1024;
static NSUInteger const STMObjectsJSONLimit = 4 * 1024 * 1024;

static BOOL STMObjectsMatches(id value, NSString *pattern) {
  return [value isKindOfClass:NSString.class] && [[NSPredicate predicateWithFormat:@"SELF MATCHES %@", pattern] evaluateWithObject:value];
}
static NSString *STMObjectsPath(NSString *path, NSString *method) {
  // Only the objects routes, each with its own method.
  NSString *one = [NSString stringWithFormat:@"/v1/objects/%@", STMObjectsUUID];
  if ([method isEqual:@"GET"] && (STMObjectsMatches(path, @"/v1/objects(?:/printers)?") || STMObjectsMatches(path, one))) return @"projects:read";
  if ([method isEqual:@"GET"] && STMObjectsMatches(path, [one stringByAppendingString:@"/passes/(0|[1-9][0-9]{0,15})/activity"])) return @"projects:read";
  if ([method isEqual:@"PATCH"] && STMObjectsMatches(path, one)) return @"captures:import";
  if ([method isEqual:@"DELETE"] && STMObjectsMatches(path, one)) return @"captures:import";
  if ([method isEqual:@"POST"] && STMObjectsMatches(path, @"/v1/objects")) return @"captures:import";
  if ([method isEqual:@"POST"] && STMObjectsMatches(path, [one stringByAppendingString:@"/(start|corrections|closeup)"])) return @"captures:import";
  if ([method isEqual:@"POST"] && STMObjectsMatches(path, [one stringByAppendingString:@"/(print|plate|printer|print-confirmation)"])) return @"printer-handoff:use";
  return nil;
}
/** The record, if it is current: unexpired and holding the scope. */
static NSDictionary *STMObjectsPairing(NSString *scope, NSString **code) {
  NSError *error = nil;
  NSDictionary *pairing = STMReadPairing(&error);
  if (error || !pairing || !STMPairingBaseURL(pairing) || [pairing[@"expiresAt"] doubleValue] <= NSDate.date.timeIntervalSince1970 * 1000) { *code = @"pairing-required"; return nil; }
  if (scope && ![pairing[@"scopes"] containsObject:scope]) { *code = @"scope-denied"; return nil; }
  return pairing;
}
static NSURL *STMObjectsRoot(NSSearchPathDirectory directory, NSString *name) {
  return [[[NSFileManager.defaultManager URLsForDirectory:directory inDomains:NSUserDomainMask] firstObject] URLByAppendingPathComponent:name isDirectory:YES];
}
/** Evenly spread picks from first to last, so every side of the object stays represented. */
static NSArray *STMObjectsSpread(NSArray *items, NSUInteger count) {
  if (items.count <= count) return items;
  NSMutableArray *picked = [NSMutableArray arrayWithCapacity:count];
  for (NSUInteger i = 0; i < count; i++) [picked addObject:items[(NSUInteger)llround((double)i * (items.count - 1) / (count - 1))]];
  return picked;
}

/** One pinned request with its own session. */
@interface STMObjectsRequest : NSObject <NSURLSessionDataDelegate>
@property NSDictionary *pairing;
@property NSUInteger limit;
@property NSMutableData *received;
@property NSHTTPURLResponse *response;
@property BOOL pinRejected;
@property BOOL tooLarge;
@property(copy) void (^done)(NSInteger status, NSData *body, NSString *code);
@end
@implementation STMObjectsRequest
+ (void)send:(NSString *)method path:(NSString *)path body:(NSData *)body type:(NSString *)type pairing:(NSDictionary *)pairing limit:(NSUInteger)limit
        done:(void (^)(NSInteger status, NSData *body, NSString *code))done {
  STMObjectsRequest *request = [STMObjectsRequest new];
  request.pairing = pairing; request.limit = limit; request.received = [NSMutableData new]; request.done = done;
  NSMutableURLRequest *http = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:path relativeToURL:STMPairingBaseURL(pairing)].absoluteURL];
  http.HTTPMethod = method; http.HTTPBody = body;
  [http setValue:[@"Bearer " stringByAppendingString:pairing[@"token"]] forHTTPHeaderField:@"Authorization"];
  [http setValue:pairing[@"deviceId"] forHTTPHeaderField:@"X-Scan-Device"];
  if (body) [http setValue:type forHTTPHeaderField:@"Content-Type"];
  NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  config.URLCache = nil; config.HTTPShouldSetCookies = NO;
  // Scans are tens of megabytes over Wi-Fi.
  config.timeoutIntervalForRequest = 90; config.timeoutIntervalForResource = body.length > STMObjectsPhotoLimit ? 600 : 180;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:config delegate:request delegateQueue:NSOperationQueue.mainQueue];
  [[session dataTaskWithRequest:http] resume];
  [session finishTasksAndInvalidate];
}
- (void)URLSession:(NSURLSession *)s task:(NSURLSessionTask *)t willPerformHTTPRedirection:(NSHTTPURLResponse *)r newRequest:(NSURLRequest *)q completionHandler:(void (^)(NSURLRequest *))done { done(nil); }
- (void)URLSession:(NSURLSession *)s didReceiveChallenge:(NSURLAuthenticationChallenge *)c completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))done {
  if (STMPinnedTrust(c, self.pairing, done)) self.pinRejected = YES;
}
- (void)URLSession:(NSURLSession *)s dataTask:(NSURLSessionDataTask *)t didReceiveResponse:(NSURLResponse *)r completionHandler:(void (^)(NSURLSessionResponseDisposition))done {
  self.response = (NSHTTPURLResponse *)r;
  if (self.response.expectedContentLength > (long long)self.limit) { self.tooLarge = YES; done(NSURLSessionResponseCancel); return; }
  done(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)s dataTask:(NSURLSessionDataTask *)t didReceiveData:(NSData *)d {
  if (d.length > self.limit - MIN(self.limit, self.received.length)) { self.tooLarge = YES; [t cancel]; return; }
  [self.received appendData:d];
}
- (void)URLSession:(NSURLSession *)s task:(NSURLSessionTask *)t didCompleteWithError:(NSError *)e {
  void (^done)(NSInteger, NSData *, NSString *) = self.done; self.done = nil;
  if (!done) return;
  if (self.tooLarge) { done(0, nil, @"payload-too-large"); return; }
  if (e) { done(0, nil, self.pinRejected ? @"certificate-changed" : @"unreachable"); return; }
  NSError *pe = nil; NSDictionary *now = STMReadPairing(&pe);
  if (pe || !STMSamePairing(now, self.pairing)) { done(0, nil, @"pairing-changed"); return; }
  done(self.response.statusCode, self.received, nil);
}
@end

@interface ObjectsBridge : NSObject <RCTBridgeModule, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIAdaptivePresentationControllerDelegate>
@property NSMutableSet<NSString *> *uploading;
@property NSString *pickObject;
@property(copy) RCTPromiseResolveBlock pickResolve;
@property(copy) RCTPromiseRejectBlock pickReject;
@end

@implementation ObjectsBridge
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (instancetype)init { if ((self = [super init])) _uploading = [NSMutableSet set]; return self; }

static NSString *STMObjectsMessage(NSString *code) {
  NSDictionary *messages = @{
    @"pairing-required": @"Connect to your Mac again.", @"scope-denied": @"Connect to your Mac again.",
    @"pairing-changed": @"Connect to your Mac again.",
    @"certificate-changed": @"Your Mac presented a different certificate. Scan a new QR code from it.",
    @"unreachable": @"Your Mac isn't answering. Check it's on and awake, then try again.",
    @"payload-too-large": @"That file is too large to send.",
    @"invalid-request": @"That request isn't allowed.",
  };
  return messages[code] ?: @"Something went wrong talking to your Mac. Try again.";
}

RCT_REMAP_METHOD(call, callOptions:(NSDictionary *)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSString *method = o[@"method"], *path = o[@"path"], *scope = STMObjectsPath(path, method), *code = nil;
  id json = o[@"json"];
  if (!scope || ([method isEqual:@"GET"] && json)) { reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return; }
  NSDictionary *pairing = STMObjectsPairing(scope, &code);
  if (!pairing) { reject(code, STMObjectsMessage(code), nil); return; }
  NSData *body = nil;
  if (json) {
    if (![NSJSONSerialization isValidJSONObject:json]) { reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return; }
    body = [NSJSONSerialization dataWithJSONObject:json options:0 error:nil];
    BOOL captureStart = [method isEqual:@"POST"] && STMObjectsMatches(path, [NSString stringWithFormat:@"/v1/objects/%@/start", STMObjectsUUID]);
    NSUInteger bodyLimit = captureStart ? 128 * 1024 : 16 * 1024;
    if (!body || body.length > bodyLimit) { reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return; }
  }
  [STMObjectsRequest send:method path:path body:body type:@"application/json" pairing:pairing limit:STMObjectsJSONLimit done:^(NSInteger status, NSData *data, NSString *failure) {
    if (failure) { reject(failure, STMObjectsMessage(failure), nil); return; }
    NSString *text = data.length ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"";
    if (!text) { reject(@"invalid-response", STMObjectsMessage(@"invalid-response"), nil); return; }
    resolve(@{@"status": @(status), @"body": text});
  }];
}

/** Sends files one after another; stops at the first failure. */
- (void)upload:(NSArray<NSDictionary *> *)files objectId:(NSString *)objectId pairing:(NSDictionary *)pairing index:(NSUInteger)index sent:(NSUInteger)sent
          done:(void (^)(NSUInteger sent, NSString *code, NSString *message))done {
  if (index >= files.count) { done(sent, nil, nil); return; }
  NSDictionary *file = files[index];
  NSData *bytes = file[@"bytes"] ?: [NSData dataWithContentsOfURL:file[@"url"] options:NSDataReadingMappedIfSafe error:nil];
  NSUInteger limit = [file[@"scan"] boolValue] ? STMObjectsScanLimit : STMObjectsPhotoLimit;
  if (!bytes.length || bytes.length > limit) { done(sent, @"unreadable-file", @"A file from this scan couldn't be read."); return; }
  NSString *path = [file[@"scan"] boolValue] ? [NSString stringWithFormat:@"/v1/objects/%@/scan", objectId]
    : [NSString stringWithFormat:@"/v1/objects/%@/%@?name=%@", objectId, [file[@"depth"] boolValue] ? @"capture-depth" : [file[@"capture"] boolValue] ? @"capture" : @"photos",
       [file[@"name"] stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLQueryAllowedCharacterSet]];
  [STMObjectsRequest send:[file[@"scan"] boolValue] ? @"PUT" : @"POST" path:path body:bytes type:file[@"type"] pairing:pairing limit:STMObjectsJSONLimit
                     done:^(NSInteger status, NSData *data, NSString *failure) {
    if (failure) { done(sent, failure, STMObjectsMessage(failure)); return; }
    if (status == 409) { done(sent, @"conflict", @"This is already being touched up."); return; }
    if (status < 200 || status >= 300) { done(sent, status == 404 ? @"not-found" : @"upload-failed", @"Your Mac didn't accept a file from this scan. Try again."); return; }
    [self upload:files objectId:objectId pairing:pairing index:index + 1 sent:sent + ([file[@"scan"] boolValue] ? 0 : 1) done:done];
  }];
}

/** What the Mac already has, so a resumed send skips it. */
- (void)existing:(NSString *)objectId pairing:(NSDictionary *)pairing done:(void (^)(NSDictionary *object, NSString *code))done {
  [STMObjectsRequest send:@"GET" path:[@"/v1/objects/" stringByAppendingString:objectId] body:nil type:nil pairing:pairing limit:STMObjectsJSONLimit done:^(NSInteger status, NSData *data, NSString *failure) {
    if (failure) { done(nil, failure); return; }
    NSDictionary *body = status == 200 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSDictionary *object = [body isKindOfClass:NSDictionary.class] ? body[@"object"] : nil;
    done([object isKindOfClass:NSDictionary.class] ? object : nil, object ? nil : (status == 404 ? @"not-found" : @"upload-failed"));
  }];
}

/** Sends whatever of these files the Mac doesn't have yet, so a send cut short can simply run again. */
- (void)sendFiles:(NSArray<NSDictionary *> *)files objectId:(NSString *)objectId resolve:(void (^)(void))resolve reject:(RCTPromiseRejectBlock)reject {
  NSString *code = nil;
  NSDictionary *pairing = STMObjectsPairing(@"captures:import", &code);
  if (!pairing) { reject(code, STMObjectsMessage(code), nil); return; }
  if ([self.uploading containsObject:objectId]) { reject(@"busy", @"This is already being sent.", nil); return; }
  [self.uploading addObject:objectId];
  [self existing:objectId pairing:pairing done:^(NSDictionary *object, NSString *failure) {
    if (!object) { [self.uploading removeObject:objectId]; reject(failure, STMObjectsMessage(failure), nil); return; }
    NSArray *have = [object[@"photos"] isKindOfClass:NSArray.class] ? object[@"photos"] : @[];
    NSArray *captured = [object[@"capture"] isKindOfClass:NSArray.class] ? object[@"capture"] : @[];
    NSArray *depths = [object[@"captureDepth"] isKindOfClass:NSArray.class] ? object[@"captureDepth"] : @[];
    BOOL hasScan = [object[@"scan"] isKindOfClass:NSString.class];
    NSMutableArray *missing = [NSMutableArray array];
    for (NSDictionary *file in files) {
      BOOL there = [file[@"scan"] boolValue] ? hasScan : [([file[@"depth"] boolValue] ? depths : [file[@"capture"] boolValue] ? captured : have) containsObject:file[@"name"]];
      if (!there) [missing addObject:file];
    }
    [self upload:missing objectId:objectId pairing:pairing index:0 sent:0 done:^(NSUInteger sent, NSString *uploadFailure, NSString *message) {
      [self.uploading removeObject:objectId];
      if (uploadFailure) reject(uploadFailure, message, nil);
      else resolve();
    }];
  }];
}

RCT_REMAP_METHOD(sendCapture, sendCaptureOptions:(NSDictionary *)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSString *objectId = o[@"objectId"], *runID = o[@"runID"];
  NSInteger maxPhotos = [o[@"maxPhotos"] integerValue];
  if (!STMObjectsMatches(objectId, STMObjectsUUID) || !STMObjectsMatches(runID, STMObjectsUUID) || maxPhotos < 0 || maxPhotos > 48) {
    reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return;
  }
  NSURL *run = [STMObjectsRoot(NSDocumentDirectory, @"NativeCaptures") URLByAppendingPathComponent:runID isDirectory:YES];
  NSURL *model = [run URLByAppendingPathComponent:@"Models/model-mobile.usdz"];
  NSNumber *regular = nil;
  if (![model getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil] || !regular.boolValue) {
    reject(@"no-model", @"The scan didn't finish making a model. Scan it again.", nil); return;
  }
  NSArray<NSString *> *names = [[NSFileManager.defaultManager contentsOfDirectoryAtPath:[run URLByAppendingPathComponent:@"Images"].path error:nil]
    filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"SELF MATCHES %@", @"[A-Za-z0-9][A-Za-z0-9._ -]{0,122}\\.(HEIC|heic|JPG|jpg|JPEG|jpeg|PNG|png)"]];
  names = [names sortedArrayUsingSelector:@selector(compare:)];
  NSMutableArray *files = [NSMutableArray arrayWithObject:@{@"scan": @YES, @"url": model, @"type": @"model/vnd.usdz+zip"}];
  for (NSString *name in STMObjectsSpread(names, (NSUInteger)maxPhotos)) {
    if ([name containsString:@".."]) continue;
    NSString *ext = name.pathExtension.lowercaseString;
    NSString *type = [ext isEqual:@"heic"] ? @"image/heic" : [ext isEqual:@"png"] ? @"image/png" : @"image/jpeg";
    [files addObject:@{@"name": name, @"url": [[run URLByAppendingPathComponent:@"Images" isDirectory:YES] URLByAppendingPathComponent:name], @"type": type}];
  }
  [self sendFiles:files objectId:objectId resolve:^{
    resolve(@{@"scanSent": @YES, @"photosSent": @(files.count - 1)});
  } reject:reject];
}

/** Send the saved RGB/depth pairs, retaining compatibility with earlier embedded-depth photos. */
RCT_REMAP_METHOD(sendHandheld, sendHandheldOptions:(NSDictionary *)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSString *objectId = o[@"objectId"];
  if (!STMObjectsMatches(objectId, STMObjectsUUID)) { reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return; }
  NSURL *folder = [STMObjectsRoot(NSDocumentDirectory, @"HandheldCaptures") URLByAppendingPathComponent:objectId isDirectory:YES];
  NSNumber *finished = nil;
  if (![[folder URLByAppendingPathComponent:@"finished"] getResourceValue:&finished forKey:NSURLIsRegularFileKey error:nil] || !finished.boolValue) {
    reject(@"unfinished-capture", @"This capture hasn't finished saving. Your capture is still saved on this phone.", nil); return;
  }
  NSArray<NSString *> *contents = [NSFileManager.defaultManager contentsOfDirectoryAtPath:folder.path error:nil];
  NSArray<NSString *> *names = [[contents
    filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"SELF MATCHES %@", @"[0-9]{4}\\.heic"]] sortedArrayUsingSelector:@selector(compare:)];
  if (names.count == 0) { reject(@"no-photos", @"The scan has no photos. Scan it again.", nil); return; }
  // A damaged streaming capture must not silently become a legacy photo-only upload.
  BOOL exactDepthRequired = [contents containsObject:@"capture-frames.jsonl"] ||
    [contents filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"SELF ENDSWITH %@", @".depth.plist"]].count > 0;
  NSMutableArray *files = [NSMutableArray array];
  for (NSString *name in names) {
    NSString *depthName = [name.stringByDeletingPathExtension stringByAppendingString:@".depth.plist"];
    NSURL *depthURL = [folder URLByAppendingPathComponent:depthName];
    BOOL hasDepth = [NSFileManager.defaultManager fileExistsAtPath:depthURL.path];
    if (exactDepthRequired && !hasDepth) {
      reject(@"incomplete-depth", @"A recorded frame is missing its depth file. Your capture is still saved on this phone.", nil); return;
    }
    if (hasDepth) {
      // Send original depth first. The companion refuses to reconstruct an incomplete RGB/depth set.
      [files addObject:@{@"depth": @YES, @"name": depthName, @"url": depthURL, @"type": @"application/octet-stream"}];
    }
    [files addObject:@{@"capture": @YES, @"name": name, @"url": [folder URLByAppendingPathComponent:name], @"type": @"image/heic"}];
  }
  [self sendFiles:files objectId:objectId resolve:^{
    resolve(@{@"photosSent": @(names.count), @"captureManifest": @{@"version": @1, @"images": names, @"depthRequired": @(exactDepthRequired)}});
  } reject:reject];
}

#pragma mark Photos and camera

- (BOOL)sheetBusy:(UIViewController *)presenter { return self.pickResolve || !presenter || presenter.presentedViewController; }
- (void)finishPick:(NSArray<NSDictionary *> *)photos {
  // Chosen on the start screen: kept here until Make it.
  if (self.pickResolve && !self.pickObject) { [self finishChosen:photos]; return; }
  RCTPromiseResolveBlock resolve = self.pickResolve; RCTPromiseRejectBlock reject = self.pickReject; NSString *objectId = self.pickObject;
  self.pickResolve = nil; self.pickReject = nil; self.pickObject = nil;
  if (!resolve) return;
  if (!photos.count) { resolve(@{@"photosSent": @0}); return; }
  [self sendFiles:photos objectId:objectId resolve:^{ resolve(@{@"photosSent": @(photos.count)}); } reject:reject];
}
static NSDictionary *STMObjectsPhoto(NSData *data, NSString *ext) {
  NSString *type = [ext isEqual:@"png"] ? @"image/png" : [ext isEqual:@"heic"] ? @"image/heic" : @"image/jpeg";
  NSString *name = [NSString stringWithFormat:@"closeup-%lld-%@.%@", (long long)(NSDate.date.timeIntervalSince1970 * 1000), [NSUUID.UUID.UUIDString substringToIndex:8].lowercaseString, ext];
  return @{@"name": name, @"bytes": data, @"type": type};
}

RCT_REMAP_METHOD(pickPhotos, pickPhotosOptions:(NSDictionary *)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSInteger limit = [o[@"limit"] integerValue];
  UIViewController *presenter = RCTPresentedViewController();
  if (!STMObjectsMatches(o[@"objectId"], STMObjectsUUID) || limit < 1 || limit > 24) { reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return; }
  if ([self sheetBusy:presenter]) { reject(@"busy", @"Close the current sheet first.", nil); return; }
  PHPickerConfiguration *configuration = [[PHPickerConfiguration alloc] init];
  configuration.filter = [PHPickerFilter imagesFilter]; configuration.selectionLimit = limit;
  configuration.preferredAssetRepresentationMode = PHPickerConfigurationAssetRepresentationModeCurrent;
  PHPickerViewController *picker = [[PHPickerViewController alloc] initWithConfiguration:configuration];
  picker.delegate = self; picker.presentationController.delegate = self;
  self.pickObject = o[@"objectId"]; self.pickResolve = resolve; self.pickReject = reject;
  [presenter presentViewController:picker animated:YES completion:nil];
}
- (void)presentationControllerDidDismiss:(UIPresentationController *)controller { [self finishPick:@[]]; }
- (void)picker:(PHPickerViewController *)picker didFinishPicking:(NSArray<PHPickerResult *> *)results {
  [picker dismissViewControllerAnimated:YES completion:nil];
  if (!self.pickResolve) return;
  NSMutableArray *photos = [NSMutableArray array];
  dispatch_group_t group = dispatch_group_create();
  for (PHPickerResult *result in results) {
    NSString *identifier = nil, *ext = nil;
    for (NSArray *pair in @[@[UTTypeHEIC, @"heic"], @[UTTypeJPEG, @"jpg"], @[UTTypePNG, @"png"]])
      if (!identifier && [result.itemProvider hasItemConformingToTypeIdentifier:[pair[0] identifier]]) { identifier = [pair[0] identifier]; ext = pair[1]; }
    if (!identifier) continue;
    dispatch_group_enter(group);
    [result.itemProvider loadDataRepresentationForTypeIdentifier:identifier completionHandler:^(NSData *data, NSError *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (data.length && data.length <= STMObjectsPhotoLimit) [photos addObject:STMObjectsPhoto(data, ext)];
        dispatch_group_leave(group);
      });
    }];
  }
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{ [self finishPick:photos]; });
}

RCT_REMAP_METHOD(takePhoto, takePhotoOptions:(NSDictionary *)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  UIViewController *presenter = RCTPresentedViewController();
  if (!STMObjectsMatches(o[@"objectId"], STMObjectsUUID)) { reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return; }
  if (![UIImagePickerController isSourceTypeAvailable:UIImagePickerControllerSourceTypeCamera]) { reject(@"no-camera", @"This device has no camera. Attach photos instead.", nil); return; }
  if ([self sheetBusy:presenter]) { reject(@"busy", @"Close the current sheet first.", nil); return; }
  UIImagePickerController *camera = [UIImagePickerController new];
  camera.sourceType = UIImagePickerControllerSourceTypeCamera; camera.delegate = self; camera.presentationController.delegate = self;
  self.pickObject = o[@"objectId"]; self.pickResolve = resolve; self.pickReject = reject;
  [presenter presentViewController:camera animated:YES completion:nil];
}
- (void)imagePickerController:(UIImagePickerController *)picker didFinishPickingMediaWithInfo:(NSDictionary<UIImagePickerControllerInfoKey, id> *)info {
  [picker dismissViewControllerAnimated:YES completion:nil];
  NSData *jpeg = UIImageJPEGRepresentation(info[UIImagePickerControllerOriginalImage], 0.9);
  [self finishPick:jpeg.length ? @[STMObjectsPhoto(jpeg, @"jpg")] : @[]];
}
- (void)imagePickerControllerDidCancel:(UIImagePickerController *)picker {
  [picker dismissViewControllerAnimated:YES completion:nil];
  [self finishPick:@[]];
}

#pragma mark Photos chosen on the start screen

// Photos picked before anything is sent: kept on this phone until Make it, shown from their cache
// file, then sent to the new object. Their ids are `<uuid>.<ext>` in Caches/ObjectsChosen.
static NSURL *STMObjectsChosenRoot(void) { return STMObjectsRoot(NSCachesDirectory, @"ObjectsChosen"); }

RCT_REMAP_METHOD(choosePhotos, choosePhotosOptions:(NSDictionary *)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSInteger limit = [o[@"limit"] integerValue];
  UIViewController *presenter = RCTPresentedViewController();
  if (limit < 1 || limit > 24) { reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return; }
  if ([self sheetBusy:presenter]) { reject(@"busy", @"Close the current sheet first.", nil); return; }
  PHPickerConfiguration *configuration = [[PHPickerConfiguration alloc] init];
  configuration.filter = [PHPickerFilter imagesFilter]; configuration.selectionLimit = limit;
  configuration.preferredAssetRepresentationMode = PHPickerConfigurationAssetRepresentationModeCurrent;
  PHPickerViewController *picker = [[PHPickerViewController alloc] initWithConfiguration:configuration];
  picker.delegate = self; picker.presentationController.delegate = self;
  self.pickObject = nil; self.pickResolve = resolve; self.pickReject = reject;
  [presenter presentViewController:picker animated:YES completion:nil];
}

/** Keeps chosen photos in the cache and resolves their ids and display URIs. */
- (void)finishChosen:(NSArray<NSDictionary *> *)photos {
  RCTPromiseResolveBlock resolve = self.pickResolve; self.pickResolve = nil; self.pickReject = nil;
  if (!resolve) return;
  NSURL *root = STMObjectsChosenRoot();
  [NSFileManager.defaultManager createDirectoryAtURL:root withIntermediateDirectories:YES attributes:nil error:nil];
  NSMutableArray *chosen = [NSMutableArray array];
  for (NSDictionary *photo in photos) {
    NSString *name = [NSString stringWithFormat:@"%@.%@", NSUUID.UUID.UUIDString.lowercaseString, [photo[@"name"] pathExtension]];
    NSURL *url = [root URLByAppendingPathComponent:name];
    if ([photo[@"bytes"] writeToURL:url options:NSDataWritingAtomic error:nil]) [chosen addObject:@{@"id": name, @"uri": url.absoluteString}];
  }
  resolve(chosen);
}

RCT_REMAP_METHOD(sendChosen, sendChosenOptions:(NSDictionary *)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSString *objectId = o[@"objectId"]; NSArray *ids = o[@"ids"];
  if (!STMObjectsMatches(objectId, STMObjectsUUID) || ![ids isKindOfClass:NSArray.class] || ids.count > 24) { reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return; }
  NSMutableArray *files = [NSMutableArray array];
  for (id chosen in ids) {
    if (!STMObjectsMatches(chosen, @"[a-f0-9-]{36}\\.(jpg|png|heic)")) { reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return; }
    NSString *ext = [chosen pathExtension];
    NSString *type = [ext isEqual:@"png"] ? @"image/png" : [ext isEqual:@"heic"] ? @"image/heic" : @"image/jpeg";
    [files addObject:@{@"name": [@"photo-" stringByAppendingString:chosen], @"url": [STMObjectsChosenRoot() URLByAppendingPathComponent:chosen], @"type": type}];
  }
  if (!files.count) { resolve(@{@"photosSent": @0}); return; }
  [self sendFiles:files objectId:objectId resolve:^{
    for (NSDictionary *file in files) [NSFileManager.defaultManager removeItemAtURL:file[@"url"] error:nil];
    resolve(@{@"photosSent": @(files.count)});
  } reject:reject];
}

#pragma mark Downloads and the 3D view

/** Downloads one object file into the cache (once per object version) and returns its URL. */
- (void)fetch:(NSString *)objectId name:(NSString *)name version:(NSString *)version done:(void (^)(NSURL *url, NSString *code))done {
  NSString *code = nil;
  NSDictionary *pairing = STMObjectsPairing([name isEqual:@"plate.jpg"] ? @"printer-handoff:use" : @"projects:read", &code);
  if (!pairing) { done(nil, code); return; }
  NSURL *folder = [[STMObjectsRoot(NSCachesDirectory, @"Objects") URLByAppendingPathComponent:objectId isDirectory:YES] URLByAppendingPathComponent:version isDirectory:YES];
  NSURL *target = [folder URLByAppendingPathComponent:[name stringByReplacingOccurrencesOfString:@"/" withString:@"_"]];
  if ([NSFileManager.defaultManager fileExistsAtPath:target.path] && ![name isEqual:@"plate.jpg"]) { done(target, nil); return; }
  NSString *path = [NSString stringWithFormat:@"/v1/objects/%@/%@", objectId, [name stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLPathAllowedCharacterSet]];
  [STMObjectsRequest send:@"GET" path:path body:nil type:nil pairing:pairing limit:STMObjectsScanLimit done:^(NSInteger status, NSData *data, NSString *failure) {
    if (failure) { done(nil, failure); return; }
    if (status != 200 || !data.length) { done(nil, status == 404 ? @"not-found" : @"download-failed"); return; }
    // Older versions of this object are no longer shown. The current version's
    // folder stays: its other files may be downloading at the same time.
    NSURL *objectFolder = folder.URLByDeletingLastPathComponent;
    for (NSURL *other in [NSFileManager.defaultManager contentsOfDirectoryAtURL:objectFolder includingPropertiesForKeys:nil options:0 error:nil])
      if (![other.lastPathComponent isEqual:version]) [NSFileManager.defaultManager removeItemAtURL:other error:nil];
    [NSFileManager.defaultManager createDirectoryAtURL:folder withIntermediateDirectories:YES attributes:nil error:nil];
    done([data writeToURL:target options:NSDataWritingAtomic error:nil] ? target : nil, nil);
  }];
}

RCT_REMAP_METHOD(download, downloadOptions:(NSDictionary *)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSString *objectId = o[@"objectId"], *name = o[@"name"];
  if (!STMObjectsMatches(objectId, STMObjectsUUID) || !STMObjectsMatches(name, @"model\\.stl|plate\\.jpg|renders/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\\.png|(?:photos|capture)/[A-Za-z0-9][A-Za-z0-9._ -]{0,127}") || [name containsString:@".."]) {
    reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return;
  }
  [self fetch:objectId name:name version:[NSString stringWithFormat:@"%lld", [o[@"version"] longLongValue]] done:^(NSURL *url, NSString *code) {
    if (url) resolve(@{@"uri": url.absoluteString});
    else reject(code ?: @"download-failed", code ? STMObjectsMessage(code) : @"That file couldn't be saved on this phone.", nil);
  }];
}

RCT_REMAP_METHOD(showModel, showModelOptions:(NSDictionary *)o resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSString *objectId = o[@"objectId"];
  if (!STMObjectsMatches(objectId, STMObjectsUUID)) { reject(@"invalid-request", STMObjectsMessage(@"invalid-request"), nil); return; }
  [self fetch:objectId name:@"model.stl" version:[NSString stringWithFormat:@"%lld", [o[@"version"] longLongValue]] done:^(NSURL *url, NSString *code) {
    UIViewController *presenter = RCTPresentedViewController();
    if (!url) { reject(code ?: @"download-failed", STMObjectsMessage(code), nil); return; }
    if (!presenter || presenter.presentedViewController) { reject(@"busy", @"Close the current sheet first.", nil); return; }
    MDLAsset *asset = [[MDLAsset alloc] initWithURL:url];
    SCNScene *scene = asset ? [SCNScene sceneWithMDLAsset:asset] : nil;
    SCNVector3 low, high;
    if (!scene || ![scene.rootNode getBoundingBoxMin:&low max:&high]) { reject(@"preview-error", @"This model couldn't be shown.", nil); return; }
    [scene.rootNode enumerateChildNodesUsingBlock:^(SCNNode *node, BOOL *stop) {
      if (!node.geometry) return;
      SCNMaterial *material = [SCNMaterial material];
      material.diffuse.contents = [UIColor colorWithRed:0.77 green:0.32 blue:0.17 alpha:1];
      material.roughness.contents = @0.7; material.lightingModelName = SCNLightingModelPhysicallyBased;
      node.geometry.materials = @[material];
    }];
    UIViewController *viewer = [UIViewController new];
    viewer.title = @"Turn it around";
    SCNView *view = [[SCNView alloc] initWithFrame:presenter.view.bounds];
    view.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    view.scene = scene; view.allowsCameraControl = YES; view.autoenablesDefaultLighting = YES;
    view.backgroundColor = [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *traits) {
      return traits.userInterfaceStyle == UIUserInterfaceStyleDark ? [UIColor colorWithRed:0.07 green:0.09 blue:0.07 alpha:1] : [UIColor colorWithRed:0.96 green:0.95 blue:0.92 alpha:1];
    }];
    viewer.view = view;
    viewer.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone target:self action:@selector(closeModel)];
    UINavigationController *navigation = [[UINavigationController alloc] initWithRootViewController:viewer];
    navigation.modalPresentationStyle = UIModalPresentationFullScreen;
    [presenter presentViewController:navigation animated:YES completion:^{ resolve(nil); }];
  }];
}
- (void)closeModel { [RCTPresentedViewController() dismissViewControllerAnimated:YES completion:nil]; }
@end
