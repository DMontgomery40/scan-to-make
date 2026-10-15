#import <Foundation/Foundation.h>
#import "../../modules/local-project-storage/ios/CompanionPairing.mm"
int main(){@autoreleasepool{
 NSMutableDictionary *r=[@{@"baseUrl":@"https://host.example.ts.net",@"protocolVersion":@"0.1.0",@"deviceId":NSUUID.UUID.UUIDString,@"token":[@"" stringByPaddingToLength:43 withString:@"x" startingAtIndex:0],@"expiresAt":@123,@"scopes":@[@"generation:health",@"projects:read",@"prepared-jobs:read"]} mutableCopy];
 if(!ValidRecord(r)){fputs("FAIL prepared-only capability rejected\n",stderr);return 1;}
 for(NSArray *bad in @[@[@"generation:health",@"unknown"],@[@"generation:health",@"prepared-jobs:read",@"prepared-jobs:read"],@[@"generation:health",@1]]){r[@"scopes"]=bad;if(ValidRecord(r))return 2;}
 r[@"scopes"]=@[@"generation:health",@"generation:create"];if(!ValidRecord(r))return 3;
 puts("PASS prepared-only and generation capabilities; malformed scopes rejected");return 0;
}}
