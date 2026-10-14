#import "ScanCaptureModule.h"
#import <ARKit/ARKit.h>

#if __has_include("ScanCapture/ScanCapture-Swift.h")
#import "ScanCapture/ScanCapture-Swift.h"
#else
#import "ScanCapture-Swift.h"
#endif

@implementation ScanCaptureModule {
  ScanCaptureSession *_session;
}

RCT_EXPORT_MODULE(ScanCapture)

- (instancetype)init
{
  if (self = [super init]) {
    _session = [ScanCaptureSession shared];
    __weak ScanCaptureModule *weakSelf = self;
    _session.onSample = ^(NSDictionary<NSString *, id> *sample) {
      [weakSelf emitOnSample:sample];
    };
    _session.onError = ^(NSString *message) {
      [weakSelf emitOnError:message];
    };
  }
  return self;
}

- (void)isSupported:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve(@([ScanCaptureSession isSupported]));
}

- (void)startSession:(double)sampleIntervalMs
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [_session startWithSampleIntervalMs:sampleIntervalMs
                           completion:^(NSDictionary<NSString *, id> *info, NSString *error) {
                             if (error != nil) {
                               reject(@"scan_capture_start", error, nil);
                             } else {
                               resolve(info);
                             }
                           }];
}

- (void)stopSession:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_session stop];
  resolve(nil);
}

- (void)invalidate
{
  [_session stop];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeScanCaptureSpecJSI>(params);
}

@end
