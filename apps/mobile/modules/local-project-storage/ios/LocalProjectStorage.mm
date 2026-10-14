#import <React/RCTBridgeModule.h>
#import <sqlite3.h>

@interface LocalProjectStorage : NSObject <RCTBridgeModule>
@end

@implementation LocalProjectStorage
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }

// Each call owns its connection. SQLite, not a JS queue, arbitrates all writers.
- (sqlite3 *)openDatabase {
  NSURL *directory = [[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];
  directory = [directory URLByAppendingPathComponent:@"SavedProjects" isDirectory:YES];
  NSError *error;
  if (![[NSFileManager defaultManager] createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:&error]) return NULL;
  sqlite3 *db = NULL;
  if (sqlite3_open([[directory URLByAppendingPathComponent:@"projects.sqlite3"].path fileSystemRepresentation], &db) != SQLITE_OK) {
    if (db) sqlite3_close(db);
    return NULL;
  }
  sqlite3_busy_timeout(db, 5000);
  // FULL rollback-journal commits survive normal process termination. Device
  // power-loss durability remains subject to the OS/filesystem flush guarantees.
  if (sqlite3_exec(db, "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, bytes BLOB NOT NULL);", NULL, NULL, NULL) != SQLITE_OK) {
    sqlite3_close(db); return NULL;
  }
  return db;
}
- (void)fail:(RCTPromiseRejectBlock)reject database:(sqlite3 *)db {
  if (db) sqlite3_close(db);
  reject(@"local_storage", @"Local project storage could not complete the operation.", nil);
}
RCT_REMAP_METHOD(listIds, listIdsResolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  sqlite3 *db = [self openDatabase];
  if (!db) { [self fail:reject database:NULL]; return; }
  sqlite3_stmt *statement = NULL;
  if (sqlite3_prepare_v2(db, "SELECT id FROM projects ORDER BY id", -1, &statement, NULL) != SQLITE_OK) { [self fail:reject database:db]; return; }
  NSMutableArray *ids = [NSMutableArray new];
  int rc;
  while ((rc = sqlite3_step(statement)) == SQLITE_ROW) {
    [ids addObject:[NSString stringWithUTF8String:(const char *)sqlite3_column_text(statement, 0)]];
  }
  sqlite3_finalize(statement);
  if (rc != SQLITE_DONE) { [self fail:reject database:db]; return; }
  sqlite3_close(db); resolve(ids);
}
RCT_REMAP_METHOD(read, readId:(NSString *)projectId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  sqlite3 *db = [self openDatabase];
  if (!db) { [self fail:reject database:NULL]; return; }
  sqlite3_stmt *statement = NULL;
  if (sqlite3_prepare_v2(db, "SELECT bytes FROM projects WHERE id=?", -1, &statement, NULL) != SQLITE_OK) { [self fail:reject database:db]; return; }
  sqlite3_bind_text(statement, 1, projectId.UTF8String, -1, SQLITE_TRANSIENT);
  int rc = sqlite3_step(statement);
  NSString *value = nil;
  if (rc == SQLITE_ROW) value = [[NSString alloc] initWithBytes:sqlite3_column_blob(statement, 0) length:sqlite3_column_bytes(statement, 0) encoding:NSUTF8StringEncoding];
  sqlite3_finalize(statement);
  if ((rc != SQLITE_ROW && rc != SQLITE_DONE) || (rc == SQLITE_ROW && !value)) { [self fail:reject database:db]; return; }
  sqlite3_close(db); resolve(value ?: (id)kCFNull);
}
RCT_REMAP_METHOD(compareAndSwap, casId:(NSString *)projectId expected:(NSString *)expected next:(NSString *)next resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  sqlite3 *db = [self openDatabase];
  if (!db) { [self fail:reject database:NULL]; return; }
  sqlite3_stmt *statement = NULL;
  BOOL absent = expected == nil || (id)expected == (id)kCFNull;
  const char *sql = absent ? "INSERT OR IGNORE INTO projects(id, bytes) VALUES (?, ?)" : "UPDATE projects SET bytes=? WHERE id=? AND bytes=?";
  if (sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL) != SQLITE_OK || sqlite3_prepare_v2(db, sql, -1, &statement, NULL) != SQLITE_OK) { [self fail:reject database:db]; return; }
  NSData *bytes = [next dataUsingEncoding:NSUTF8StringEncoding];
  sqlite3_bind_text(statement, absent ? 1 : 2, projectId.UTF8String, -1, SQLITE_TRANSIENT);
  sqlite3_bind_blob(statement, absent ? 2 : 1, bytes.length ? bytes.bytes : "", (int)bytes.length, SQLITE_TRANSIENT);
  if (!absent) {
    NSData *old = [expected dataUsingEncoding:NSUTF8StringEncoding];
    sqlite3_bind_blob(statement, 3, old.length ? old.bytes : "", (int)old.length, SQLITE_TRANSIENT);
  }
  int rc = sqlite3_step(statement);
  BOOL changed = sqlite3_changes(db) == 1;
  sqlite3_finalize(statement);
  if (rc != SQLITE_DONE || sqlite3_exec(db, "COMMIT", NULL, NULL, NULL) != SQLITE_OK) { [self fail:reject database:db]; return; }
  sqlite3_close(db); resolve(@(changed));
}
@end
