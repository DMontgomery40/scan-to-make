#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>

// Full-screen camera that returns the first QR code it reads. Pairing reads
// the companion's QR with it; the string is validated in JavaScript.
@interface STMQRScannerController : UIViewController<AVCaptureMetadataOutputObjectsDelegate>
@property(copy) void (^finish)(NSString *value);
@end
@implementation STMQRScannerController {
  AVCaptureSession *_session;
  AVCaptureVideoPreviewLayer *_preview;
  dispatch_queue_t _sessionQueue;
  BOOL _done;
}
- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.blackColor;
  _session = [AVCaptureSession new];
  // Start and stop run in order on one queue, so a quick Cancel always stops the camera.
  _sessionQueue = dispatch_queue_create("com.scantomake.qr-session", DISPATCH_QUEUE_SERIAL);
  AVCaptureDevice *camera = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
  AVCaptureDeviceInput *input = camera ? [AVCaptureDeviceInput deviceInputWithDevice:camera error:nil] : nil;
  AVCaptureMetadataOutput *output = [AVCaptureMetadataOutput new];
  if (input && [_session canAddInput:input] && [_session canAddOutput:output]) {
    [_session addInput:input];
    [_session addOutput:output];
    [output setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
    output.metadataObjectTypes = @[AVMetadataObjectTypeQRCode];
    _preview = [AVCaptureVideoPreviewLayer layerWithSession:_session];
    _preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
    [self.view.layer addSublayer:_preview];
  }
  UILabel *hint = [UILabel new];
  hint.text = @"Point the camera at the QR code on your computer.";
  hint.textColor = UIColor.whiteColor;
  hint.font = [UIFont preferredFontForTextStyle:UIFontTextStyleHeadline];
  hint.adjustsFontForContentSizeCategory = YES;
  hint.numberOfLines = 0;
  hint.textAlignment = NSTextAlignmentCenter;
  hint.translatesAutoresizingMaskIntoConstraints = NO;
  __weak STMQRScannerController *weakSelf = self;
  UIButtonConfiguration *config = [UIButtonConfiguration glassButtonConfiguration];
  config.title = @"Cancel";
  UIButton *cancel = [UIButton buttonWithConfiguration:config primaryAction:[UIAction actionWithHandler:^(UIAction *a) { [weakSelf complete:nil]; }]];
  cancel.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:hint];
  [self.view addSubview:cancel];
  UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [hint.topAnchor constraintEqualToAnchor:safe.topAnchor constant:24],
    [hint.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:24],
    [hint.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-24],
    [cancel.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor constant:-24],
    [cancel.centerXAnchor constraintEqualToAnchor:safe.centerXAnchor],
  ]];
}
- (void)viewDidLayoutSubviews { [super viewDidLayoutSubviews]; _preview.frame = self.view.bounds; }
- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  if (!_preview) { [self complete:nil]; return; }
  AVCaptureSession *session = _session;
  dispatch_async(_sessionQueue, ^{ [session startRunning]; });
}
- (void)captureOutput:(AVCaptureOutput *)output didOutputMetadataObjects:(NSArray<AVMetadataObject *> *)objects fromConnection:(AVCaptureConnection *)connection {
  for (AVMetadataObject *object in objects) {
    if ([object isKindOfClass:AVMetadataMachineReadableCodeObject.class]) {
      NSString *value = ((AVMetadataMachineReadableCodeObject *)object).stringValue;
      if (value.length) { [self complete:value]; return; }
    }
  }
}
- (void)complete:(NSString *)value {
  if (_done) return;
  _done = YES;
  AVCaptureSession *session = _session;
  if (_sessionQueue) dispatch_async(_sessionQueue, ^{ [session stopRunning]; });
  void (^finish)(NSString *) = self.finish;
  [self dismissViewControllerAnimated:YES completion:^{ if (finish) finish(value); }];
}
@end

@interface QRScannerBridge : NSObject<RCTBridgeModule>
@end
@implementation QRScannerBridge
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
RCT_REMAP_METHOD(scan, scanResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  UIViewController *presenter = RCTPresentedViewController();
  if (!presenter || presenter.presentedViewController) { reject(@"busy", @"Close the current sheet first.", nil); return; }
  if (![AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo]) { reject(@"no-camera", @"This device has no camera to scan with. Enter the code instead.", nil); return; }
  void (^present)(void) = ^{
    STMQRScannerController *scanner = [STMQRScannerController new];
    scanner.modalPresentationStyle = UIModalPresentationFullScreen;
    scanner.finish = ^(NSString *value) {
      if (value) resolve(value); else reject(@"cancelled", @"Scanning cancelled.", nil);
    };
    [presenter presentViewController:scanner animated:YES completion:nil];
  };
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
  if (status == AVAuthorizationStatusAuthorized) { present(); return; }
  if (status != AVAuthorizationStatusNotDetermined) { reject(@"camera-denied", @"Camera access is off for Scan to Make. Turn it on in Settings, or enter the code instead.", nil); return; }
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (granted) present(); else reject(@"camera-denied", @"Camera access is off for Scan to Make. Turn it on in Settings, or enter the code instead.", nil);
    });
  }];
}
@end
