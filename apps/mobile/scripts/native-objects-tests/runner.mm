#if STM_OBJECTS_HOST
#import <Foundation/Foundation.h>
#import "React/RCTBridgeModule.h"

// The production file methods below run unchanged. Only native paths, pairing and HTTP
// completion are controlled; no real Documents, credentials, network, or simulator is used.
static NSURL *fixtureRoot;
static NSMutableArray<NSDictionary *> *requests;
static NSMutableDictionary *remoteObject;
static NSString *failOnceName;
static NSString *const objectID = @"11111111-2222-3333-4444-555555555555";
static void Require(BOOL ok, NSString *why) {
    if (!ok) @throw [NSException exceptionWithName:@"HostTestFailure" reason:why userInfo:nil];
}
static NSString *const STMObjectsUUID = @"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
static NSUInteger const STMObjectsScanLimit = 64 * 1024 * 1024;
static NSUInteger const STMObjectsPhotoLimit = 25 * 1024 * 1024;
static NSUInteger const STMObjectsJSONLimit = 4 * 1024 * 1024;
// HOST_MATCHES
// HOST_PATH
// HOST_MESSAGE
static NSURL *STMObjectsRoot(NSSearchPathDirectory directory, NSString *name) { return [fixtureRoot URLByAppendingPathComponent:name isDirectory:YES]; }
static NSDictionary *STMObjectsPairing(NSString *scope, NSString **code) { return @{@"scope":scope}; }

@interface STMObjectsRequest : NSObject
@end
@implementation STMObjectsRequest
+ (void)send:(NSString *)method path:(NSString *)path body:(NSData *)body type:(NSString *)type pairing:(NSDictionary *)pairing limit:(NSUInteger)limit
        done:(void (^)(NSInteger, NSData *, NSString *))done {
    [requests addObject:@{@"method":method,@"path":path,@"body":body ?: NSData.data,@"type":type ?: @"",@"scope":pairing[@"scope"] ?: @""}];
    if ([method isEqual:@"GET"]) {
        done(200,[NSJSONSerialization dataWithJSONObject:@{@"object":remoteObject} options:0 error:nil],nil); return;
    }
    if ([path hasSuffix:@"/start"] || [path hasSuffix:@"/print-confirmation"]) {
        done(200,[NSJSONSerialization dataWithJSONObject:@{@"object":remoteObject} options:0 error:nil],nil); return;
    }
    NSURLComponents *url=[NSURLComponents componentsWithString:[@"https://fixture.invalid" stringByAppendingString:path]];
    NSString *name=nil;
    for (NSURLQueryItem *item in url.queryItems) if ([item.name isEqual:@"name"]) name=item.value;
    Require(name != nil, @"upload includes filename");
    if ([name isEqual:failOnceName]) { failOnceName=nil; done(503,NSData.data,nil); return; }
    NSString *collection=[url.path hasSuffix:@"/capture-depth"] ? @"captureDepth" : @"capture";
    NSMutableArray *names=[remoteObject[collection] mutableCopy];
    if (![names containsObject:name]) [names addObject:name];
    remoteObject[collection]=names;
    done(200,[NSJSONSerialization dataWithJSONObject:@{@"object":remoteObject} options:0 error:nil],nil);
}
@end

@interface ObjectsBridge : NSObject
@property NSMutableSet<NSString *> *uploading;
@end
@implementation ObjectsBridge
- (instancetype)init { if ((self=[super init])) _uploading=[NSMutableSet set]; return self; }
// HOST_CALL
// HOST_UPLOAD
// HOST_EXISTING
// HOST_SEND_FILES
// HOST_SEND_HANDHELD
@end

static NSURL *CaptureFolder(void) { return [[STMObjectsRoot(NSDocumentDirectory,@"HandheldCaptures") URLByAppendingPathComponent:objectID] copy]; }
static void Reset(NSURL *scratch, NSString *name) {
    fixtureRoot=[scratch URLByAppendingPathComponent:name isDirectory:YES];
    Require([NSFileManager.defaultManager createDirectoryAtURL:CaptureFolder() withIntermediateDirectories:YES attributes:nil error:nil],@"private capture folder");
    Require([NSData.data writeToURL:[CaptureFolder() URLByAppendingPathComponent:@"finished"] atomically:YES],@"local finished marker");
    requests=[NSMutableArray array]; remoteObject=[@{@"photos":@[],@"capture":@[],@"captureDepth":@[]} mutableCopy]; failOnceName=nil;
}
static void Put(NSString *name, NSString *payload) {
    Require([[payload dataUsingEncoding:NSUTF8StringEncoding] writeToURL:[CaptureFolder() URLByAppendingPathComponent:name] atomically:YES],@"fixture payload written");
}
static NSArray *Uploads(void) {
    return [requests filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"method == %@",@"POST"]];
}
static NSArray *UploadPaths(void) { return [Uploads() valueForKey:@"path"]; }
static NSString *Path(NSString *route, NSString *name) { return [NSString stringWithFormat:@"/v1/objects/%@/%@?name=%@",objectID,route,name]; }
static id Send(ObjectsBridge *bridge, NSString *expectedError) {
    __block id result=nil; __block NSString *failure=nil;
    [bridge sendHandheldOptions:@{@"objectId":objectID} resolve:^(id value){result=value;} reject:^(NSString *code,NSString *message,NSError *error){failure=code;}];
    if (expectedError) Require([failure isEqual:expectedError] && result==nil,[@"expected " stringByAppendingString:expectedError]);
    else Require(result!=nil && failure==nil,[@"send succeeded: " stringByAppendingString:failure ?: @""]);
    Require(bridge.uploading.count==0,@"upload ownership released after completion/failure");
    return result;
}
int main(void) { @autoreleasepool {
    NSURL *scratch=[NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString] isDirectory:YES];
    int status=0;
    @try {
        Reset(scratch,@"paired");
        Put(@"0001.heic",@"rgb-one"); Put(@"0001.depth.plist",@"bplist00-depth-one");
        Put(@"0000.heic",@"rgb-zero"); Put(@"0000.depth.plist",@"bplist00-depth-zero"); Put(@"capture-frames.jsonl",@"{}\n");
        ObjectsBridge *bridge=[ObjectsBridge new];
        id result=Send(bridge,nil);
        Require([result[@"photosSent"] integerValue]==2,@"paired upload reports RGB count, not file count");
        NSDictionary *pairedManifest=@{@"version":@1,@"images":@[@"0000.heic",@"0001.heic"],@"depthRequired":@YES};
        Require([result[@"captureManifest"] isEqual:pairedManifest],@"successful paired upload returns the full sorted completion manifest");
        Require([UploadPaths() isEqual:@[Path(@"capture-depth",@"0000.depth.plist"),Path(@"capture",@"0000.heic"),Path(@"capture-depth",@"0001.depth.plist"),Path(@"capture",@"0001.heic")]],@"each depth uploads before its RGB, in filename order");
        Require([Uploads()[0][@"body"] isEqual:[@"bplist00-depth-zero" dataUsingEncoding:NSUTF8StringEncoding]] && [Uploads()[1][@"body"] isEqual:[@"rgb-zero" dataUsingEncoding:NSUTF8StringEncoding]],@"original depth/RGB bytes preserved");
        Require([Uploads()[0][@"type"] isEqual:@"application/octet-stream"] && [Uploads()[1][@"type"] isEqual:@"image/heic"],@"depth/RGB content types");
        [requests removeAllObjects]; result=Send(bridge,nil);
        Require(Uploads().count==0,@"complete paired retry uploads nothing twice");
        Require([result[@"captureManifest"] isEqual:pairedManifest],@"retry manifest includes every local image even when all uploads are skipped");
        Require([[NSData dataWithContentsOfURL:[CaptureFolder() URLByAppendingPathComponent:@"0000.heic"]] isEqual:[@"rgb-zero" dataUsingEncoding:NSUTF8StringEncoding]] && [NSFileManager.defaultManager fileExistsAtPath:[CaptureFolder() URLByAppendingPathComponent:@"0001.depth.plist"].path],@"successful completion and retry retain original RGB/depth files");

        Reset(scratch,@"interrupted"); Put(@"0000.heic",@"rgb"); Put(@"0000.depth.plist",@"bplist00-depth"); Put(@"capture-frames.jsonl",@"{}\n");
        bridge=[ObjectsBridge new]; failOnceName=@"0000.heic"; Send(bridge,@"upload-failed");
        Require([remoteObject[@"captureDepth"] isEqual:@[@"0000.depth.plist"]] && [remoteObject[@"capture"] count]==0,@"failure retained only the sent depth");
        Require([NSFileManager.defaultManager fileExistsAtPath:[CaptureFolder() URLByAppendingPathComponent:@"0000.heic"].path],@"failed upload retains local source");
        [requests removeAllObjects]; result=Send(bridge,nil);
        Require([UploadPaths() isEqual:@[Path(@"capture",@"0000.heic")]],@"retry independently skips existing depth while sending missing RGB");
        Require([result[@"captureManifest"] isEqual:@{@"version":@1,@"images":@[@"0000.heic"],@"depthRequired":@YES}],@"partial retry returns the complete image set after remaining upload succeeds");
        remoteObject[@"captureDepth"]=@[]; [requests removeAllObjects]; Send(bridge,nil);
        Require([UploadPaths() isEqual:@[Path(@"capture-depth",@"0000.depth.plist")]],@"existing RGB does not hide a missing depth sidecar");

        Reset(scratch,@"missing-depth"); Put(@"0000.heic",@"rgb0"); Put(@"0000.depth.plist",@"bplist00-depth"); Put(@"0001.heic",@"rgb1"); Put(@"capture-frames.jsonl",@"{}\n");
        Send([ObjectsBridge new],@"incomplete-depth");
        Require(requests.count==0,@"missing later sidecar rejected before any request/upload");
        Require([NSFileManager.defaultManager fileExistsAtPath:[CaptureFolder() URLByAppendingPathComponent:@"0001.heic"].path],@"rejected capture remains on disk");
        Reset(scratch,@"all-depth-missing"); Put(@"0000.heic",@"rgb"); Put(@"capture-frames.jsonl",@"{}\n");
        Send([ObjectsBridge new],@"incomplete-depth"); Require(requests.count==0,@"stream journal prevents legacy downgrade when all sidecars are missing");

        Reset(scratch,@"unfinished"); Put(@"0000.heic",@"rgb"); Put(@"0000.depth.plist",@"bplist00-depth");
        Require([NSFileManager.defaultManager removeItemAtURL:[CaptureFolder() URLByAppendingPathComponent:@"finished"] error:nil],@"remove fixture completion marker");
        Send([ObjectsBridge new],@"unfinished-capture"); Require(requests.count==0,@"unfinished capture fails before every network request and yields no manifest");
        Require([NSFileManager.defaultManager fileExistsAtPath:[CaptureFolder() URLByAppendingPathComponent:@"0000.depth.plist"].path],@"unfinished rejection retains depth source");
        Require([NSFileManager.defaultManager createDirectoryAtURL:[CaptureFolder() URLByAppendingPathComponent:@"finished"] withIntermediateDirectories:NO attributes:nil error:nil],@"directory fixture at marker path");
        Send([ObjectsBridge new],@"unfinished-capture"); Require(requests.count==0,@"a directory is not a completed capture marker");

        Reset(scratch,@"legacy"); Put(@"0000.heic",@"opaque legacy HEIC with embedded depth"); Put(@"0001.heic",@"opaque legacy HEIC two");
        result=Send([ObjectsBridge new],nil);
        Require([result[@"photosSent"] integerValue]==2 && [UploadPaths() isEqual:@[Path(@"capture",@"0000.heic"),Path(@"capture",@"0001.heic")]],@"legacy embedded-depth photos remain accepted without fabricated sidecars");
        Require([result[@"captureManifest"] isEqual:@{@"version":@1,@"images":@[@"0000.heic",@"0001.heic"],@"depthRequired":@NO}],@"finished legacy capture explicitly declares no lossless depth sidecars");

        // The public maximum manifest fits the start route without enlarging other JSON routes.
        NSMutableArray *allNames=[NSMutableArray arrayWithCapacity:10000];
        for (NSUInteger i=0;i<10000;i++) [allNames addObject:[NSString stringWithFormat:@"%04lu.heic",(unsigned long)i]];
        NSDictionary *largeManifest=@{@"captureManifest":@{@"version":@1,@"images":allNames,@"depthRequired":@YES}};
        [requests removeAllObjects]; __block id reply=nil; __block NSString *failure=nil;
        [bridge callOptions:@{@"method":@"POST",@"path":[NSString stringWithFormat:@"/v1/objects/%@/start",objectID],@"json":largeManifest} resolve:^(id r){reply=r;} reject:^(NSString*c,NSString*m,NSError*e){failure=c;}];
        Require(reply!=nil && failure==nil && requests.count==1,@"start accepts the full10000-name manifest within128KiB");
        Require([[NSJSONSerialization JSONObjectWithData:requests[0][@"body"] options:0 error:nil] isEqual:largeManifest],@"start sends the exact completion manifest JSON");
        [requests removeAllObjects]; reply=nil; failure=nil;
        [bridge callOptions:@{@"method":@"POST",@"path":@"/v1/objects",@"json":largeManifest} resolve:^(id r){reply=r;} reject:^(NSString*c,NSString*m,NSError*e){failure=c;}];
        Require(reply==nil && [failure isEqual:@"invalid-request"] && requests.count==0,@"other routes keep their16KiB JSON limit");
        reply=nil; failure=nil;
        NSString *oversized=[@"x" stringByPaddingToLength:128*1024 withString:@"x" startingAtIndex:0];
        [bridge callOptions:@{@"method":@"POST",@"path":[NSString stringWithFormat:@"/v1/objects/%@/start",objectID],@"json":@{@"captureManifest":oversized}} resolve:^(id r){reply=r;} reject:^(NSString*c,NSString*m,NSError*e){failure=c;}];
        Require(reply==nil && [failure isEqual:@"invalid-request"] && requests.count==0,@"start payloads above128KiB remain bounded");
        NSString *confirmationPath=[NSString stringWithFormat:@"/v1/objects/%@/print-confirmation",objectID];
        for (NSDictionary *answer in @[@{@"action":@"accept",@"content":@{@"plate_clear":@YES,@"watch":@NO}},@{@"action":@"cancel"}]) {
            NSDictionary *confirmation=@{@"confirmationId":@"question-1",@"answer":answer};
            [requests removeAllObjects]; reply=nil; failure=nil;
            [bridge callOptions:@{@"method":@"POST",@"path":confirmationPath,@"json":confirmation} resolve:^(id r){reply=r;} reject:^(NSString*c,NSString*m,NSError*e){failure=c;}];
            Require(reply!=nil && failure==nil && requests.count==1,@"print confirmation uses authenticated object transport");
            Require([requests[0][@"scope"] isEqual:@"printer-handoff:use"],@"confirmation requires printer scope");
            Require([[NSJSONSerialization JSONObjectWithData:requests[0][@"body"] options:0 error:nil] isEqual:confirmation],@"confirmation ID, action and boolean fields are unchanged");
        }
        Require(STMObjectsPath(confirmationPath,@"GET")==nil && STMObjectsPath(confirmationPath,@"PATCH")==nil,@"confirmation only permits POST");
        NSString *filamentPath=[NSString stringWithFormat:@"/v1/objects/%@/filaments",objectID];
        Require([STMObjectsPath(filamentPath,@"GET") isEqual:@"printer-handoff:use"],@"filament inventory requires printer scope");
        Require(STMObjectsPath(filamentPath,@"POST")==nil && STMObjectsPath(filamentPath,@"PATCH")==nil,@"filament inventory only permits GET");
        printf("NATIVE_OBJECTS_HOST_PASS full completion manifest, finished-marker guard, paired retry, source retention, legacy capture and bounded start payload\n");
    } @catch (NSException *error) {
        fprintf(stderr,"FAIL %s\n",error.reason.UTF8String); status=1;
    } @finally { [NSFileManager.defaultManager removeItemAtURL:scratch error:nil]; }
    return status;
} }
#else
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

#endif
