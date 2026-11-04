#import <AppKit/AppKit.h>

int main(void) {
  @autoreleasepool {
    NSMutableArray *displays = [NSMutableArray array];
    for (NSScreen *screen in NSScreen.screens) {
      [displays addObject:@{
        @"displayId": screen.deviceDescription[@"NSScreenNumber"],
        @"currentHeadroom": @(screen.maximumExtendedDynamicRangeColorComponentValue),
        @"potentialHeadroom": @(screen.maximumPotentialExtendedDynamicRangeColorComponentValue),
        @"referenceHeadroom": @(screen.maximumReferenceExtendedDynamicRangeColorComponentValue)
      }];
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:displays options:0 error:nil];
    if (!data) return 1;
    fwrite(data.bytes, 1, data.length, stdout);
  }
  return 0;
}
