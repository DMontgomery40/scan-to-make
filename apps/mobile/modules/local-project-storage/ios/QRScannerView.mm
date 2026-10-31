#import <React/RCTViewManager.h>
#import <React/RCTComponent.h>
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>

// A camera viewfinder that lives inside the pairing screen. It reports the
// first QR code it reads, then stays quiet until JavaScript re-arms it (by
// turning `active` off and on), so a single-use code is never sent twice.
// The string is validated in JavaScript.
@interface STMQRScannerView : UIView<AVCaptureMetadataOutputObjectsDelegate>
@property(nonatomic) BOOL active;
@property(nonatomic, copy) RCTDirectEventBlock onCode;
// "ready", "no-camera" or "denied".
@property(nonatomic, copy) RCTDirectEventBlock onState;
@end

@implementation STMQRScannerView {
  AVCaptureSession *_session;
  AVCaptureVideoPreviewLayer *_preview;
  dispatch_queue_t _queue;
  BOOL _configured;
  BOOL _fired;
  BOOL _running;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.backgroundColor = UIColor.blackColor;
    self.clipsToBounds = YES;
    // Start and stop run in order on one queue, never on the main thread.
    _queue = dispatch_queue_create("com.scantomake.qr-view", DISPATCH_QUEUE_SERIAL);
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:self selector:@selector(update) name:UIApplicationDidEnterBackgroundNotification object:nil];
    [center addObserver:self selector:@selector(update) name:UIApplicationDidBecomeActiveNotification object:nil];
  }
  return self;
}

- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  AVCaptureSession *session = _session;
  if (session) dispatch_async(_queue, ^{ [session stopRunning]; });
}

- (void)setActive:(BOOL)active {
  // Turning it back on re-arms it for the next code.
  if (active && !_active) _fired = NO;
  _active = active;
  [self update];
}

- (void)didMoveToWindow {
  [super didMoveToWindow];
  [self update];
}

- (void)layoutSubviews {
  [super layoutSubviews];
  _preview.frame = self.bounds;
}

- (void)report:(NSString *)state {
  if (self.onState) self.onState(@{@"state": state});
}

// Runs the camera only while this view is on screen, active and in the foreground.
- (void)update {
  BOOL wanted = self.active && self.window != nil &&
    UIApplication.sharedApplication.applicationState != UIApplicationStateBackground;
  if (!wanted) {
    [self stop];
    return;
  }
  if (![AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo]) {
    [self report:@"no-camera"];
    return;
  }
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
  if (status == AVAuthorizationStatusNotDetermined) {
    __weak STMQRScannerView *weakSelf = self;
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (granted) [weakSelf update]; else [weakSelf report:@"denied"];
      });
    }];
    return;
  }
  if (status != AVAuthorizationStatusAuthorized) {
    [self report:@"denied"];
    return;
  }
  if (![self configure]) {
    [self report:@"no-camera"];
    return;
  }
  [self report:@"ready"];
  if (_running) return;
  _running = YES;
  AVCaptureSession *session = _session;
  dispatch_async(_queue, ^{ [session startRunning]; });
}

- (void)stop {
  if (!_running) return;
  _running = NO;
  AVCaptureSession *session = _session;
  dispatch_async(_queue, ^{ [session stopRunning]; });
}

- (BOOL)configure {
  if (_configured) return _session != nil;
  _configured = YES;
  AVCaptureDevice *camera = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
  AVCaptureDeviceInput *input = camera ? [AVCaptureDeviceInput deviceInputWithDevice:camera error:nil] : nil;
  AVCaptureSession *session = [AVCaptureSession new];
  AVCaptureMetadataOutput *output = [AVCaptureMetadataOutput new];
  if (!input || ![session canAddInput:input] || ![session canAddOutput:output]) return NO;
  [session addInput:input];
  [session addOutput:output];
  [output setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
  output.metadataObjectTypes = @[AVMetadataObjectTypeQRCode];
  _session = session;
  _preview = [AVCaptureVideoPreviewLayer layerWithSession:session];
  _preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
  _preview.frame = self.bounds;
  [self.layer addSublayer:_preview];
  return YES;
}

- (void)captureOutput:(AVCaptureOutput *)output didOutputMetadataObjects:(NSArray<AVMetadataObject *> *)objects fromConnection:(AVCaptureConnection *)connection {
  if (_fired || !self.active) return;
  for (AVMetadataObject *object in objects) {
    if (![object isKindOfClass:AVMetadataMachineReadableCodeObject.class]) continue;
    NSString *value = ((AVMetadataMachineReadableCodeObject *)object).stringValue;
    if (value.length == 0 || value.length > 4096) continue;
    _fired = YES;
    if (self.onCode) self.onCode(@{@"value": value});
    return;
  }
}
@end

@interface STMQRScannerViewManager : RCTViewManager
@end
@implementation STMQRScannerViewManager
RCT_EXPORT_MODULE(STMQRScannerView)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (UIView *)view { return [STMQRScannerView new]; }
RCT_EXPORT_VIEW_PROPERTY(active, BOOL)
RCT_EXPORT_VIEW_PROPERTY(onCode, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onState, RCTDirectEventBlock)
@end
