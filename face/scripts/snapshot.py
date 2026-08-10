"""Save a PNG of the robot face window so it can be looked at directly.

Usage: python3 scripts/snapshot.py <window_id> <output.png>
"""
import sys

import Quartz

wid = int(sys.argv[1])
out = sys.argv[2]

img = Quartz.CGWindowListCreateImage(
    Quartz.CGRectNull,
    Quartz.kCGWindowListOptionIncludingWindow,
    wid,
    Quartz.kCGWindowImageBoundsIgnoreFraming,
)
url = Quartz.CFURLCreateWithFileSystemPath(None, out, Quartz.kCFURLPOSIXPathStyle, False)
dest = Quartz.CGImageDestinationCreateWithURL(url, 'public.png', 1, None)
Quartz.CGImageDestinationAddImage(dest, img, None)
Quartz.CGImageDestinationFinalize(dest)
print(out, Quartz.CGImageGetWidth(img), 'x', Quartz.CGImageGetHeight(img))
