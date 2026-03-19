"""
core/detector_github.py — Integración del modelo Shoplifting-Detection-System (GitHub)
SOLO para agregar alertas extras, no modifica nada existente
"""
import torch
import torch.nn as nn
import torchvision.models as models
import cv2
import numpy as np
from collections import deque
import logging

logger = logging.getLogger(__name__)

class GitHubShopliftingDetector:
    """
    Wrapper para el modelo del repositorio 224Abhay/Shoplifting-Detection-System
    Arquitectura: YOLO (detección) + ResNet50 (features) + LSTM (temporal)
    """
    
    def __init__(self, ruta_modelo, umbral=0.65):
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        logger.info(f"🔧 Inicializando detector GitHub en: {self.device}")
        
        self.umbral = umbral
        self.secuencia_len = 16  # El modelo espera secuencias de 16 frames
        
        # Buffers por cámara (acumulan frames para la secuencia)
        self.buffers = {}  # camera_id -> deque de frames
        
        # Cargar modelo
        self.modelo = self._cargar_modelo(ruta_modelo)
        
    def _cargar_modelo(self, ruta):
        """Carga la arquitectura ResNet50 + LSTM y los pesos del .pth"""
        try:
            # 1. Crear backbone ResNet50 (sin la última capa)
            resnet = models.resnet50(weights=None)
            resnet = nn.Sequential(*list(resnet.children())[:-1])  # Quita la FC
            resnet.out_features = 2048
            
            # 2. Crear LSTM
            lstm = nn.LSTM(
                input_size=2048,
                hidden_size=512,
                num_layers=2,
                batch_first=True,
                dropout=0.5
            )
            
            # 3. Clasificador final
            classifier = nn.Sequential(
                nn.Linear(512, 256),
                nn.ReLU(),
                nn.Dropout(0.5),
                nn.Linear(256, 2)  # 2 clases: normal, shoplifting
            )
            
            # 4. Cargar pesos
            checkpoint = torch.load(ruta, map_location=self.device)
            
            # El checkpoint puede venir de diferentes formas
            if isinstance(checkpoint, dict):
                if 'resnet' in checkpoint:
                    resnet.load_state_dict(checkpoint['resnet'])
                if 'lstm' in checkpoint:
                    lstm.load_state_dict(checkpoint['lstm'])
                if 'classifier' in checkpoint:
                    classifier.load_state_dict(checkpoint['classifier'])
            else:
                # Si es un state_dict plano, asumimos que es el modelo completo
                # (poco probable, pero por si acaso)
                logger.warning("Checkpoint en formato desconocido, intentando carga directa")
            
            # Mover a device
            resnet = resnet.to(self.device)
            lstm = lstm.to(self.device)
            classifier = classifier.to(self.device)
            
            # Modo evaluación
            resnet.eval()
            lstm.eval()
            classifier.eval()
            
            logger.info("✅ Modelo GitHub cargado exitosamente")
            
            return {
                'resnet': resnet,
                'lstm': lstm,
                'classifier': classifier
            }
            
        except Exception as e:
            logger.error(f"❌ Error cargando modelo GitHub: {e}")
            return None
    
    def _preprocesar_frame(self, frame_bgr):
        """
        Preprocesa un frame para ResNet50:
        - BGR -> RGB
        - Redimensionar a 224x224
        - Normalizar con mean/std de ImageNet
        """
        # BGR a RGB
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        
        # Redimensionar
        frame_resized = cv2.resize(frame_rgb, (224, 224))
        
        # Normalizar (valores entre 0 y 1)
        frame_norm = frame_resized / 255.0
        
        # Convertir a tensor y normalizar con stats de ImageNet
        mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
        std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
        
        frame_tensor = torch.from_numpy(frame_norm).float().permute(2, 0, 1)
        frame_tensor = (frame_tensor - mean) / std
        
        return frame_tensor
    
    def procesar_frame(self, camera_id, frame_bgr):
        """
        Procesa un frame y retorna (detectado, probabilidad)
        
        Args:
            camera_id: ID de la cámara (para mantener buffer)
            frame_bgr: frame de OpenCV (BGR)
        
        Returns:
            tuple: (bool, float) - (es_hurto, confianza)
        """
        if self.modelo is None:
            return (False, 0.0)
        
        # Inicializar buffer si no existe
        if camera_id not in self.buffers:
            self.buffers[camera_id] = deque(maxlen=self.secuencia_len)
        
        # Preprocesar frame
        frame_tensor = self._preprocesar_frame(frame_bgr)
        self.buffers[camera_id].append(frame_tensor)
        
        # Solo predecir cuando tenemos secuencia completa
        if len(self.buffers[camera_id]) == self.secuencia_len:
            try:
                # Apilar frames: (seq_len, 3, 224, 224)
                secuencia = torch.stack(list(self.buffers[camera_id]), dim=0)
                
                # Extraer features con ResNet50 para cada frame
                with torch.no_grad():
                    features = []
                    for i in range(self.secuencia_len):
                        frame_batch = secuencia[i].unsqueeze(0).to(self.device)
                        feat = self.modelo['resnet'](frame_batch)  # (1, 2048, 1, 1)
                        # Aplanar correctamente: de (1, 2048, 1, 1) a (2048)
                        feat = feat.flatten()  # (2048)
                        features.append(feat)
                    
                    # Stack features: (16, 2048)
                    features_seq = torch.stack(features, dim=0)  # (16, 2048)
                    
                    # Añadir batch para LSTM: (1, 16, 2048)
                    features_batch = features_seq.unsqueeze(0)
                                                
                    # Pasar por LSTM
                    lstm_out, _ = self.modelo['lstm'](features_batch)  # (1, 16, 512)
                    
                    # Usar el último output del LSTM
                    last_out = lstm_out[:, -1, :]  # (1, 512)
                    
                    # Clasificar
                    logits = self.modelo['classifier'](last_out)  # (1, 2)
                    probs = torch.softmax(logits, dim=1)
                    
                    # La clase 1 es "shoplifting" (según el repo)
                    prob_shoplifting = probs[0, 1].item()
                    
                    if len(self.buffers[camera_id]) == self.secuencia_len:
                        logger.info(f"🎯 Buffer lleno para cámara {camera_id}, infiriendo...")
                    return (prob_shoplifting > self.umbral, prob_shoplifting)
                    
            except Exception as e:
                logger.error(f"Error en inferencia GitHub: {e}")
                return (False, 0.0)
        
        return (False, 0.0)
    
    def reset_camera(self, camera_id):
        """Limpia buffer de una cámara"""
        if camera_id in self.buffers:
            del self.buffers[camera_id]