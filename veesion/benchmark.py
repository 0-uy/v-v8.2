import time, cv2, numpy as np
from ultralytics import YOLO

frame = np.zeros((480,640,3), dtype=np.uint8)

m1 = YOLO('models/yolo26n-pose.pt')
t = time.time()
m1(frame, verbose=False)
print(f'pose: {(time.time()-t)*1000:.0f}ms')

m2 = YOLO('models/yolo26n.pt')
t = time.time()
m2(frame, verbose=False)
print(f'obj: {(time.time()-t)*1000:.0f}ms')

m3 = YOLO('models/shoplifting_yolo_best.pt')
t = time.time()
m3(frame, verbose=False)
print(f'sl_yolo: {(time.time()-t)*1000:.0f}ms')