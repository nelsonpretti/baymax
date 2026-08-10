"""List every CoreGraphics window owned by Electron, on-screen or not."""
import Quartz

opts = Quartz.kCGWindowListOptionAll
for w in Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID):
    owner = w.get('kCGWindowOwnerName', '')
    if 'lectron' not in owner or w.get('kCGWindowName', '') != 'robot face':
        continue
    b = w.get('kCGWindowBounds', {})
    print(
        'id=%s owner=%s layer=%s onscreen=%s alpha=%s %sx%s at (%s,%s) title=%r'
        % (
            w.get('kCGWindowNumber'), owner, w.get('kCGWindowLayer'),
            w.get('kCGWindowIsOnscreen'), w.get('kCGWindowAlpha'),
            int(b.get('Width', 0)), int(b.get('Height', 0)),
            int(b.get('X', 0)), int(b.get('Y', 0)),
            w.get('kCGWindowName', ''),
        )
    )
