#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonDigest.h>
#import "../../modules/local-project-storage/ios/CompanionPairing.mm"
#import "../../modules/local-project-storage/ios/ObjectsBridge.mm"
// Drives the unchanged ObjectsBridge against the pairing fixture's real object
// service (fixture touch-up). Proves the native transport, the capture send and
// resume, downloads and the allowlist; not Claude, Blender or printing.
static UIViewController *rootController;
UIViewController *RCTPresentedViewController(void) { return rootController; }
NSString *STMHash(NSData *data){unsigned char hash[CC_SHA256_DIGEST_LENGTH];CC_SHA256(data.bytes,(CC_LONG)data.length,hash);NSMutableString*s=[NSMutableString new];for(int i=0;i<CC_SHA256_DIGEST_LENGTH;i++)[s appendFormat:@"%02x",hash[i]];return s;}
static NSDictionary *config;
static void Require(BOOL ok,NSString *why){if(!ok){fprintf(stderr,"FAIL %s\n",why.UTF8String);exit(1);}}
static NSDictionary *Json(NSString *text){id v=[NSJSONSerialization JSONObjectWithData:[text dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];return [v isKindOfClass:NSDictionary.class]?v:nil;}

@interface Driver:NSObject
@property CompanionPairing *pair;
@property ObjectsBridge *bridge;
@property NSString *objectId;
@property NSString *runID;
@property NSString *emptyRunID;
@end
@implementation Driver
- (void)call:(NSString*)method path:(NSString*)path json:(id)json status:(NSInteger)status then:(void(^)(NSDictionary*))then {
 NSMutableDictionary *o=[@{@"method":method,@"path":path} mutableCopy];if(json)o[@"json"]=json;
 [self.bridge callOptions:o resolve:^(id r){
  Require([r[@"status"] integerValue]==status,[NSString stringWithFormat:@"%@ %@ expected %ld got %@",method,path,(long)status,r[@"status"]]);
  then(Json(r[@"body"]));
 } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[NSString stringWithFormat:@"%@ %@ rejected %@",method,path,c]);}];
}
- (void)rejects:(NSDictionary*)o code:(NSString*)code {
 __block BOOL rejected=NO;
 [self.bridge callOptions:o resolve:^(id r){Require(NO,@"disallowed request accepted");} reject:^(NSString*c,NSString*m,NSError*e){rejected=[c isEqual:code];}];
 Require(rejected,[NSString stringWithFormat:@"rejects %@ with %@",o[@"path"],code]);
}
/** A finished Object Capture run folder, as NativeCaptureDraftStore leaves it. */
- (NSString*)captureWithModel:(BOOL)model photos:(NSUInteger)count {
 NSString *run=NSUUID.UUID.UUIDString.lowercaseString;
 NSURL *root=[[[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask] firstObject] URLByAppendingPathComponent:[@"NativeCaptures/" stringByAppendingString:run] isDirectory:YES];
 NSURL *images=[root URLByAppendingPathComponent:@"Images" isDirectory:YES],*models=[root URLByAppendingPathComponent:@"Models" isDirectory:YES];
 Require([NSFileManager.defaultManager createDirectoryAtURL:images withIntermediateDirectories:YES attributes:nil error:nil]&&[NSFileManager.defaultManager createDirectoryAtURL:models withIntermediateDirectories:YES attributes:nil error:nil],@"capture folders");
 if(model)Require([[@"fixture usdz bytes" dataUsingEncoding:NSUTF8StringEncoding] writeToURL:[models URLByAppendingPathComponent:@"model-mobile.usdz"] atomically:YES],@"model file");
 UIGraphicsImageRenderer *renderer=[[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(4,4)];
 NSData *image=UIImagePNGRepresentation([renderer imageWithActions:^(UIGraphicsImageRendererContext *ctx){[UIColor.redColor setFill];[ctx fillRect:CGRectMake(0,0,4,4)];}]);
 for(NSUInteger i=0;i<count;i++)Require([image writeToURL:[images URLByAppendingPathComponent:[NSString stringWithFormat:@"%05lu.%09lu.HEIC",(unsigned long)i,(unsigned long)i*7]] atomically:YES],@"image file");
 // Not a photo: never sent.
 Require([[@"x" dataUsingEncoding:NSUTF8StringEncoding] writeToURL:[images URLByAppendingPathComponent:@"notes.txt"] atomically:YES],@"stray file");
 return run;
}
- (void)negatives {
 NSString *one=[@"/v1/objects/" stringByAppendingString:self.objectId];
 [self rejects:@{@"method":@"GET",@"path":@"/v1/generate"} code:@"invalid-request"];
 [self rejects:@{@"method":@"POST",@"path":[one stringByAppendingString:@"/scan"]} code:@"invalid-request"];
 [self rejects:@{@"method":@"POST",@"path":[one stringByAppendingString:@"/photos?name=x.jpg"]} code:@"invalid-request"];
 [self rejects:@{@"method":@"GET",@"path":@"/v1/objects",@"json":@{@"x":@1}} code:@"invalid-request"];
 [self rejects:@{@"method":@"DELETE",@"path":[one stringByAppendingString:@"/start"]} code:@"invalid-request"];
 [self rejects:@{@"method":@"GET",@"path":[one stringByAppendingString:@"/../../healthz"]} code:@"invalid-request"];
 for(NSString *index in @[@"-1",@"1.5",@"01",@"1e1"]) [self rejects:@{@"method":@"GET",@"path":[one stringByAppendingFormat:@"/passes/%@/activity",index]} code:@"invalid-request"];
 [self rejects:@{@"method":@"POST",@"path":[one stringByAppendingString:@"/passes/0/activity"]} code:@"invalid-request"];
 __block BOOL badName=NO;
 [self.bridge downloadOptions:@{@"objectId":self.objectId,@"name":@"renders/../object.json",@"version":@1} resolve:^(id r){Require(NO,@"bad download name accepted");} reject:^(NSString*c,NSString*m,NSError*e){badName=[c isEqual:@"invalid-request"];}];
 Require(badName,@"download name allowlist");
 badName=NO;
 [self.bridge downloadOptions:@{@"objectId":self.objectId,@"name":@"photos/../auth.json",@"version":@1} resolve:^(id r){Require(NO,@"media folder traversal accepted");} reject:^(NSString*c,NSString*m,NSError*e){badName=[c isEqual:@"invalid-request"];}];
 Require(badName,@"media folder traversal is refused");
}
- (void)phaseOne {
 [self call:@"POST" path:@"/v1/objects" json:@{@"instructions":@"A hook for a 25 mm handle."} status:201 then:^(NSDictionary *created){
  self.objectId=created[@"object"][@"id"];Require(self.objectId.length==36,@"object id");
  [self negatives];
  [self call:@"PATCH" path:[@"/v1/objects/" stringByAppendingString:self.objectId] json:@{@"instructions":@"A revised hook for a 25 mm handle."} status:200 then:^(NSDictionary *draft){
   Require([draft[@"object"][@"instructions"] isEqual:@"A revised hook for a 25 mm handle."],@"revised draft description saved");
   [self call:@"GET" path:@"/v1/objects/printers" json:nil status:200 then:^(NSDictionary *catalog){
    Require([catalog[@"destinations"] isKindOfClass:NSArray.class],@"printer catalog reaches native caller");
    [self call:@"POST" path:[NSString stringWithFormat:@"/v1/objects/%@/printer",self.objectId] json:@{@"destinationId":@"missing"} status:409 then:^(NSDictionary *refused){
     Require([refused[@"error"][@"code"] isEqual:@"invalid-state"],@"unconfigured printer selection refused by service");
     [self capturePhase];
    }];
   }];
  }];
 }];
}
- (void)capturePhase {
  self.runID=[self captureWithModel:YES photos:30];
  [self.bridge sendCaptureOptions:@{@"objectId":self.objectId,@"runID":self.runID,@"maxPhotos":@24} resolve:^(id sent){
   Require([sent[@"scanSent"] boolValue]&&[sent[@"photosSent"] integerValue]==24,@"scan and 24 photos sent");
   [self call:@"GET" path:[@"/v1/objects/" stringByAppendingString:self.objectId] json:nil status:200 then:^(NSDictionary *got){
    NSDictionary *o=got[@"object"];
    Require([o[@"scan"] isEqual:@"scan.usdz"]&&[o[@"photos"] count]==24,@"the Mac has the scan and 24 photos");
    Require([o[@"photos"][0] isEqual:@"00000.000000000.HEIC"]&&[o[@"photos"][23] isEqual:@"00029.000000203.HEIC"],@"photos spread from first to last");
    // Sending again (as after the app was closed mid-send) adds nothing twice.
    [self.bridge sendCaptureOptions:@{@"objectId":self.objectId,@"runID":self.runID,@"maxPhotos":@24} resolve:^(id again){
     [self call:@"GET" path:[@"/v1/objects/" stringByAppendingString:self.objectId] json:nil status:200 then:^(NSDictionary *same){
      Require([same[@"object"][@"photos"] count]==24,@"resend adds no duplicates");
      self.emptyRunID=[self captureWithModel:NO photos:3];
      [self.bridge sendCaptureOptions:@{@"objectId":self.objectId,@"runID":self.emptyRunID,@"maxPhotos":@24} resolve:^(id r){Require(NO,@"a capture with no model was sent");} reject:^(NSString*c,NSString*m,NSError*e){
       Require([c isEqual:@"no-model"],@"no model is refused before sending");
       [self call:@"POST" path:[NSString stringWithFormat:@"/v1/objects/%@/start",self.objectId] json:nil status:200 then:^(NSDictionary *started){
        Require([started[@"object"][@"state"] isEqual:@"touching-up"],@"touch-up started");
        [self poll:0];
       }];
      }];
     }];
    } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"resend " stringByAppendingString:c]);}];
   }];
  } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"sendCapture " stringByAppendingString:c]);}];
}
- (void)poll:(NSUInteger)n {
 Require(n<100,@"touch-up finishes within bound");
 [self call:@"GET" path:[@"/v1/objects/" stringByAppendingString:self.objectId] json:nil status:200 then:^(NSDictionary *got){
  NSDictionary *o=got[@"object"];
  if(![o[@"state"] isEqual:@"ready"]){Require(![o[@"state"] isEqual:@"failed"],@"touch-up succeeds");dispatch_after(dispatch_time(DISPATCH_TIME_NOW,100*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[self poll:n+1];});return;}
  Require([o[@"current"][@"renders"] count]==1,@"one render");
  Require(o[@"passes"][0][@"activity"]==nil&&[o[@"passes"][0][@"activityCount"] isKindOfClass:NSNumber.class],@"project has activity metadata only");
  [self call:@"GET" path:[NSString stringWithFormat:@"/v1/objects/%@/passes/0/activity",self.objectId] json:nil status:200 then:^(NSDictionary *history){
   Require([history[@"activity"] isKindOfClass:NSArray.class],@"pass activity loads through native read route");
   [self downloadsAfterActivity:o];
  }];
 }];
}
- (void)downloadsAfterActivity:(NSDictionary*)o {
  NSNumber *version=o[@"updatedAtMs"];
  // The page loads every render at once: simultaneous downloads must all survive.
  __block NSUInteger pending=3;__block NSMutableArray *uris=[NSMutableArray array];
  void (^both)(id)=^(id r){[uris addObject:r[@"uri"]];if(--pending)return;
   for(NSString *uri in uris)Require([NSFileManager.defaultManager fileExistsAtPath:[NSURL URLWithString:uri].path],@"simultaneous downloads all kept");
   [self downloadsFrom:o version:version];};
  [self.bridge downloadOptions:@{@"objectId":self.objectId,@"name":@"model.stl",@"version":version} resolve:both reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"concurrent model " stringByAppendingString:c]);}];
  [self.bridge downloadOptions:@{@"objectId":self.objectId,@"name":@"renders/render_front.png",@"version":version} resolve:both reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"concurrent render " stringByAppendingString:c]);}];
  [self.bridge downloadOptions:@{@"objectId":self.objectId,@"name":[@"photos/" stringByAppendingString:o[@"photos"][0]],@"version":version} resolve:^(id r){
   Require([UIImage imageWithContentsOfFile:[NSURL URLWithString:r[@"uri"]].path]!=nil,@"retained photo decodes for the project gallery");both(r);
  } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"retained photo " stringByAppendingString:c]);}];
}
- (void)downloadsFrom:(NSDictionary*)o version:(NSNumber*)version {
 {
  [self.bridge downloadOptions:@{@"objectId":self.objectId,@"name":@"model.stl",@"version":version} resolve:^(id model){
   NSData *bytes=[NSData dataWithContentsOfURL:[NSURL URLWithString:model[@"uri"]]];
   Require([STMHash(bytes) isEqual:config[@"objects"][@"stl"][@"sha256"]],@"model bytes match");
   [self.bridge downloadOptions:@{@"objectId":self.objectId,@"name":@"renders/render_front.png",@"version":version} resolve:^(id render){
    Require([STMHash([NSData dataWithContentsOfURL:[NSURL URLWithString:render[@"uri"]]]) isEqual:config[@"objects"][@"render"][@"sha256"]],@"render bytes match");
    [self.bridge downloadOptions:@{@"objectId":self.objectId,@"name":@"renders/render_front.png",@"version":version} resolve:^(id cached){
     Require([cached[@"uri"] isEqual:render[@"uri"]],@"a render downloads once per version");
     [self call:@"POST" path:[NSString stringWithFormat:@"/v1/objects/%@/corrections",self.objectId] json:@{@"note":@"make it 2 mm thicker"} status:200 then:^(NSDictionary *corrected){
      Require([corrected[@"object"][@"state"] isEqual:@"touching-up"],@"a correction runs another pass");
      // This fixture Mac has no printer: Print says so as a plain conflict, not a crash.
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW,500*NSEC_PER_MSEC),dispatch_get_main_queue(),^{
       [self call:@"POST" path:[NSString stringWithFormat:@"/v1/objects/%@/print",self.objectId] json:nil status:409 then:^(NSDictionary *refused){
        Require([refused[@"error"][@"code"] isEqual:@"invalid-state"],@"print refused plainly");
        [self.pair disconnectResolve:^(id done){Require([done[@"state"] isEqual:@"disconnected"],@"credential cleanup");[self finish];} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,c);}];
       }];
      });
     }];
    } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"cached " stringByAppendingString:c]);}];
   } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"render " stringByAppendingString:c]);}];
  } reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"model " stringByAppendingString:c]);}];
 }
}
- (void)finish {
 NSDictionary *receipt=@{@"passed":@YES,@"runId":config[@"runId"],@"objectId":self.objectId};
 NSURL *url=[[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"results.json"];
 Require([[NSJSONSerialization dataWithJSONObject:receipt options:NSJSONWritingPrettyPrinted error:nil] writeToURL:url atomically:YES],@"receipt");
 printf("NATIVE_OBJECTS_PASS\n");fflush(stdout);exit(0);
}
- (void)start {
 self.bridge=[ObjectsBridge new];self.pair=[CompanionPairing new];
 if([NSProcessInfo.processInfo.arguments containsObject:@"--cleanup"]){[self.pair disconnectResolve:^(id r){exit(0);} reject:^(NSString*c,NSString*m,NSError*e){exit(1);}];return;}
 // Before pairing, every call says to connect again.
 [self.bridge callOptions:@{@"method":@"GET",@"path":@"/v1/objects"} resolve:^(id r){Require(NO,@"unpaired call accepted");} reject:^(NSString*c,NSString*m,NSError*e){
  Require([c isEqual:@"pairing-required"],@"unpaired call says pairing-required");
  [self.pair pairURL:config[@"invitation"][@"baseUrl"] code:config[@"invitation"][@"code"] deviceName:@"Objects native fixture" certificateSha256:nil resolve:^(id r){[self phaseOne];} reject:^(NSString*c,NSString*m,NSError*e){Require(NO,[@"pair " stringByAppendingString:c]);}];
 }];
}
@end
@interface SceneDelegate:UIResponder<UIWindowSceneDelegate>
@property(nonatomic,strong) UIWindow*window;
@property Driver*driver;
@end
@implementation SceneDelegate
- (void)scene:(UIScene*)scene willConnectToSession:(UISceneSession*)session options:(UISceneConnectionOptions*)options{
 config=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfURL:[NSBundle.mainBundle URLForResource:@"config" withExtension:@"json"]] options:0 error:nil];
 self.window=[[UIWindow alloc]initWithWindowScene:(UIWindowScene*)scene];rootController=[UIViewController new];self.window.rootViewController=rootController;[self.window makeKeyAndVisible];self.driver=[Driver new];[self.driver start];
 dispatch_after(dispatch_time(DISPATCH_TIME_NOW,60*NSEC_PER_SEC),dispatch_get_main_queue(),^{Require(NO,@"60-second runtime bound");});
}
@end
@interface AppDelegate:UIResponder<UIApplicationDelegate>@end
@implementation AppDelegate@end
int main(int argc,char**argv){@autoreleasepool{return UIApplicationMain(argc,argv,nil,NSStringFromClass(AppDelegate.class));}}
