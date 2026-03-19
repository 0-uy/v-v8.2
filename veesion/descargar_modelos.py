import os
import urllib.request

MODELS = {
    "shoplifting_detector.pth": "https://huggingface.co/Maau27/Veexion-models/resolve/main/shoplifting_detector.pth",
    "shoplifting_wights.pt": "https://huggingface.co/Maau27/Veexion-models/resolve/main/shoplifting_wights.pt",
    "shoplifting_yolo_best.pt": "https://huggingface.co/Maau27/Veexion-models/resolve/main/shoplifting_yolo_best.pt",
    "yolo26n.pt": "https://huggingface.co/Maau27/Veexion-models/resolve/main/yolo26n.pt",
    "yolo26n-pose.pt": "https://huggingface.co/Maau27/Veexion-models/resolve/main/yolo26n-pose.pt",
}

MODELS_DIR = os.getenv("MODELS_DIR", "models")
os.makedirs(MODELS_DIR, exist_ok=True)

for name, url in MODELS.items():
    path = os.path.join(MODELS_DIR, name)

    if not os.path.exists(path):
        print(f"Descargando {name}...")
        urllib.request.urlretrieve(url, path)
        print(f"{name} descargado")
    else:
        print(f"{name} ya existe")