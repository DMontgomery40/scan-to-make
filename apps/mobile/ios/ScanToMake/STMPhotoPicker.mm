#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <PhotosUI/PhotosUI.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <CommonCrypto/CommonDigest.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

// Close-up photos chosen in the system photo picker are copied byte for byte to
// Application Support/DetailStillFiles/<sha256>.<jpg|heic|png>, so an upload can
// send exactly the chosen bytes by identity. JavaScript receives that identity
// and a file URI for display. The picker runs out of process: the app sees only
// the chosen items and needs no photo library permission.

static const unsigned long long STMStillMaxBytes = 25ull * 1024 * 1024;
static const NSInteger STMStillMaxCount = 24;

// Mirrors the companion's magic-byte sniffing (services/companion/src/detail-stills.ts).
static NSString *STMStillMediaType(NSData *data) {
  const uint8_t *b = (const uint8_t *)data.bytes;
  NSUInteger n = data.length;
  if (n >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff) return @"image/jpeg";
  static const uint8_t png[8] = {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
  if (n >= 8 && memcmp(b, png, 8) == 0) return @"image/png";
  if (n >= 12 && memcmp(b + 4, "ftyp", 4) == 0) {
    NSString *brand = [[NSString alloc] initWithBytes:b + 8 length:4 encoding:NSASCIIStringEncoding];
    NSArray *brands = @[@"heic", @"heix", @"heim", @"heis", @"hevc", @"hevm", @"hevs", @"mif1", @"mif2"];
    if (brand && [brands containsObject:brand]) return @"image/heic";
  }
  return nil;
}

static NSString *STMStillExtension(NSString *mediaType) {
  return @{@"image/jpeg": @"jpg", @"image/heic": @"heic", @"image/png": @"png"}[mediaType];
}

static NSString *STMStillDigest(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
  return hex;
}

static NSURL *STMStillDirectory(void) {
  NSURL *support = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                         inDomains:NSUserDomainMask] firstObject];
  return [support URLByAppendingPathComponent:@"DetailStillFiles" isDirectory:YES];
}

static NSURL *STMStillURL(id sha256, id mediaType) {
  if (![sha256 isKindOfClass:NSString.class] || ![mediaType isKindOfClass:NSString.class]) return nil;
  NSString *extension = STMStillExtension(mediaType);
  NSString *hash = sha256;
  if (!extension || hash.length != 64) return nil;
  for (NSUInteger i = 0; i < hash.length; i++) {
    unichar c = [hash characterAtIndex:i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return nil;
  }
  return [STMStillDirectory() URLByAppendingPathComponent:[NSString stringWithFormat:@"%@.%@", hash, extension]];
}

static BOOL STMStillPrepareDirectory(void) {
  NSURL *directory = STMStillDirectory();
  NSError *error = nil;
  if (![NSFileManager.defaultManager createDirectoryAtURL:directory
                              withIntermediateDirectories:YES
                                               attributes:@{NSFilePosixPermissions: @0700}
                                                    error:&error]) return NO;
  // Copies are working files, not user data to restore.
  [directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  return YES;
}

/** Reads one regular file without following links, up to the limit plus one byte. */
static NSData *STMStillRead(NSURL *url, unsigned long long *size) {
  int fd = open(url.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return nil;
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) { close(fd); return nil; }
  *size = (unsigned long long)st.st_size;
  if (*size == 0 || *size > STMStillMaxBytes) { close(fd); return nil; }
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)*size];
  NSUInteger offset = 0;
  while (offset < data.length) {
    ssize_t got = read(fd, (char *)data.mutableBytes + offset, data.length - offset);
    if (got <= 0) { close(fd); return nil; }
    offset += (NSUInteger)got;
  }
  char extra;
  ssize_t tail = read(fd, &extra, 1);
  close(fd);
  return tail == 0 ? data : nil;
}

/** Publishes the bytes atomically under their digest. */
static BOOL STMStillWrite(NSData *data, NSURL *destination) {
  NSURL *temp = [STMStillDirectory() URLByAppendingPathComponent:
                 [NSString stringWithFormat:@".%@.tmp", NSUUID.UUID.UUIDString]];
  int fd = open(temp.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) return NO;
  BOOL ok = YES;
  NSUInteger offset = 0;
  while (ok && offset < data.length) {
    ssize_t put = write(fd, (const char *)data.bytes + offset, data.length - offset);
    if (put <= 0) ok = NO; else offset += (NSUInteger)put;
  }
  ok = ok && fsync(fd) == 0;
  close(fd);
  ok = ok && rename(temp.fileSystemRepresentation, destination.fileSystemRepresentation) == 0;
  unlink(temp.fileSystemRepresentation);
  return ok;
}

static NSString *STMStillTypeIdentifier(NSItemProvider *provider) {
  NSArray<UTType *> *accepted = @[UTTypeHEIC, UTTypeJPEG, UTTypePNG];
  for (NSString *identifier in provider.registeredTypeIdentifiers) {
    UTType *type = [UTType typeWithIdentifier:identifier];
    for (UTType *candidate in accepted) {
      if (type && [type conformsToType:candidate]) return identifier;
    }
  }
  // Other formats can often be delivered as JPEG by the system.
  return [provider hasItemConformingToTypeIdentifier:UTTypeJPEG.identifier] ? UTTypeJPEG.identifier : nil;
}

@interface STMPhotoPicker : NSObject <RCTBridgeModule, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate>
@property(nonatomic, copy) RCTPromiseResolveBlock pending;
@end

@implementation STMPhotoPicker
RCT_EXPORT_MODULE(STMPhotoPicker)

+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

RCT_REMAP_METHOD(pick, pickWithLimit:(double)limit resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSInteger count = (NSInteger)limit;
  UIViewController *presenter = RCTPresentedViewController();
  if (count < 1 || count > STMStillMaxCount || (double)count != limit) {
    reject(@"invalid-limit", @"Choose between 1 and 24 photos.", nil);
    return;
  }
  if (self.pending || !presenter || presenter.presentedViewController) {
    reject(@"busy", @"Close the current sheet first.", nil);
    return;
  }
  if (!STMStillPrepareDirectory()) {
    reject(@"storage", @"Photos can’t be copied right now. Check free space on this device.", nil);
    return;
  }
  PHPickerConfiguration *configuration = [[PHPickerConfiguration alloc] init];
  configuration.filter = [PHPickerFilter imagesFilter];
  configuration.selectionLimit = count;
  configuration.preferredAssetRepresentationMode = PHPickerConfigurationAssetRepresentationModeCurrent;
  if (@available(iOS 15.0, *)) configuration.selection = PHPickerConfigurationSelectionOrdered;
  PHPickerViewController *picker = [[PHPickerViewController alloc] initWithConfiguration:configuration];
  picker.delegate = self;
  picker.presentationController.delegate = self;
  self.pending = resolve;
  [presenter presentViewController:picker animated:YES completion:nil];
}

RCT_REMAP_METHOD(discard, discardFiles:(NSArray *)files resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  for (id file in files) {
    if (![file isKindOfClass:NSDictionary.class]) continue;
    NSURL *url = STMStillURL(file[@"sha256"], file[@"mediaType"]);
    if (url) unlink(url.fileSystemRepresentation);
  }
  resolve(nil);
}

- (void)finish:(NSDictionary *)result {
  RCTPromiseResolveBlock resolve = self.pending;
  self.pending = nil;
  if (resolve) resolve(result);
}

- (void)presentationControllerDidDismiss:(UIPresentationController *)controller {
  [self finish:@{@"photos": @[], @"rejected": @[]}];
}

- (void)picker:(PHPickerViewController *)picker didFinishPicking:(NSArray<PHPickerResult *> *)results {
  [picker dismissViewControllerAnimated:YES completion:nil];
  if (!self.pending) return;
  if (results.count == 0) {
    [self finish:@{@"photos": @[], @"rejected": @[]}];
    return;
  }
  NSMutableArray *outcomes = [NSMutableArray arrayWithCapacity:results.count];
  for (NSUInteger i = 0; i < results.count; i++) [outcomes addObject:NSNull.null];
  dispatch_group_t group = dispatch_group_create();
  dispatch_queue_t files = dispatch_queue_create("com.scantomake.photo-picker", DISPATCH_QUEUE_SERIAL);
  [results enumerateObjectsUsingBlock:^(PHPickerResult *result, NSUInteger index, BOOL *stop) {
    NSString *identifier = STMStillTypeIdentifier(result.itemProvider);
    if (!identifier) {
      outcomes[index] = @{@"reason": @"unsupported"};
      return;
    }
    dispatch_group_enter(group);
    [result.itemProvider loadFileRepresentationForTypeIdentifier:identifier
                                               completionHandler:^(NSURL *url, NSError *error) {
      // The system removes this file when the handler returns: copy it now.
      NSDictionary *outcome = @{@"reason": @"unreadable"};
      unsigned long long size = 0;
      NSData *data = url ? STMStillRead(url, &size) : nil;
      if (!data && size > STMStillMaxBytes) {
        outcome = @{@"reason": @"too-large", @"byteLength": @(size)};
      } else if (data) {
        NSString *mediaType = STMStillMediaType(data);
        NSString *digest = STMStillDigest(data);
        NSURL *destination = mediaType ? STMStillURL(digest, mediaType) : nil;
        if (!mediaType) {
          outcome = @{@"reason": @"unsupported"};
        } else {
          __block BOOL written = NO;
          dispatch_sync(files, ^{ written = destination && STMStillWrite(data, destination); });
          if (written) {
            outcome = @{
              @"sha256": digest,
              @"byteLength": @(data.length),
              @"mediaType": mediaType,
              @"uri": destination.absoluteString,
            };
          }
        }
      }
      dispatch_async(dispatch_get_main_queue(), ^{
        outcomes[index] = outcome;
        dispatch_group_leave(group);
      });
    }];
  }];
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    NSMutableArray *photos = [NSMutableArray array];
    NSMutableArray *rejected = [NSMutableArray array];
    for (NSDictionary *outcome in outcomes) {
      if (outcome[@"sha256"]) [photos addObject:outcome]; else [rejected addObject:outcome];
    }
    [self finish:@{@"photos": photos, @"rejected": rejected}];
  });
}

@end
