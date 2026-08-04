# main.py — Serveur DVS (version ROBUSTE, à déployer sur le Raspberry Pi)
#
# Ce qui a changé vs ta version d'origine :
#   1. device audio DÉTECTÉ automatiquement (recherche "Logitech"/"G432"/USB),
#      avec repli sur le device par défaut -> plus de crash "mauvais device".
#   2. Logs des ratios REÇUS (toutes les ~0,5 s quand ça change) + résumé
#      toutes les 5 s -> tu vois si le téléphone envoie.
#   3. IP LAN réelle pour l'annonce mDNS (plus de 127.0.1.1).
#   4. Mode auto-test :  python3 main.py --test  (envoie un POST à lui-même)
#
# Déploiement : copier ce fichier sur le Pi dans ~/phase/main.py, puis :
#   sudo python3 main.py            (production)
#   sudo python3 main.py --dev      (contrôle clavier)
#   python3 main.py --test          (vérifie que le port 5005 répond, sans son)

import sys
import time
import math
import threading
import socket
import numpy as np
import sounddevice as sd
import soundfile as sf
from zeroconf import IPVersion, ServiceInfo, Zeroconf
from http.server import BaseHTTPRequestHandler, HTTPServer

# --- VERIFICATION DES ARGUMENTS ---
MODE_DEV = "--dev" in sys.argv
MODE_TEST = "--test" in sys.argv

if MODE_DEV:
    from getkey import getkey, keys

# --- CONFIGURATION ---
HTTP_IP = "0.0.0.0"
HTTP_PORT = 5005
FICHIER_WAV = "timecode.wav"

vitesse_actuelle = 0.0 if not MODE_DEV else 1.0
continuer_programme = True
position_lecture = 0.0
dernier_paquet_temps = time.time()
premier_paquet_recu = False
dernier_ratio_logue = None

# Lissage du ratio côté serveur : le module est lissé (anti à-coups de
# pitch), le SIGNE reste instantané (backspin/scratch réactifs).
# alpha 0.1 à ~10 requêtes/s -> constante de temps ~1 s.
LISSAGE_ALPHA = 0.1
module_lisse = 0.0

# --- 1. CHARGEMENT DU FICHIER AUDIO ---
print("Chargement du fichier timecode en mémoire...")
try:
    data_audio, SAMPLING_RATE = sf.read(FICHIER_WAV)
    if len(data_audio.shape) == 1:
        data_audio = np.column_stack((data_audio, data_audio))
    total_frames = len(data_audio)
    print(f"Fichier chargé ! ({total_frames} samples, {SAMPLING_RATE}Hz)")
except Exception as e:
    print(f"Erreur : Impossible de lire le fichier {FICHIER_WAV}.")
    print("Vérifie qu'il est bien dans le même dossier.")
    exit(1)

# --- 2. CONFIGURATION DU RÉSEAU ---
def obtenir_ip_lan():
    """IP LAN réelle (pas 127.0.1.1). Astuce UDP : aucune donnée envoyée,
    ça ne nécessite pas Internet."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return socket.gethostbyname(socket.gethostname())

mon_ip = obtenir_ip_lan()

# mDNS : si zeroconf est indisponible ou plante, on ne fait pas tomber le serveur
try:
    info = ServiceInfo(
        "_dvs._udp.local.",
        "Raspberry-Pi-DVS._dvs._udp.local.",
        addresses=[socket.inet_aton(mon_ip)],
        port=HTTP_PORT,
        properties={},
    )
    zeroconf = Zeroconf(ip_version=IPVersion.V4Only)
    zeroconf.register_service(info)
except Exception as e:
    print(f"(mDNS non disponible : {e})")
    info, zeroconf = None, None

# --- 3. DÉTECTION DU DEVICE AUDIO (plus de crash "device=2 n'existe pas") ---
def trouver_device_audio():
    try:
        devices = sd.query_devices()
        print("Appareils audio disponibles :")
        for i, d in enumerate(devices):
            nom = str(d.get("name", ""))
            sorties = d.get("max_output_channels", 0)
            print(f"  [{i}] {nom} (sorties: {sorties})")
            if sorties > 0 and ("logitech" in nom.lower() or "g432" in nom.lower() or "usb" in nom.lower()):
                return i
    except Exception as e:
        print(f"(impossible de lister les devices : {e})")
    # Repli : device de sortie par défaut
    try:
        d = sd.default.device
        if isinstance(d, (list, tuple)):
            return d[1]
        return d
    except Exception:
        return None

DEVICE_AUDIO = trouver_device_audio()
if DEVICE_AUDIO is None:
    print("ERREUR : aucun device audio de sortie trouvé.")
    exit(1)
print(f"Device audio utilisé : {DEVICE_AUDIO}")

# --- 4. MOTEUR AUDIO (Lecture du WAV) ---
# Note : vitesse_actuelle est un RATIO SIGNÉ. Négatif = lecture à reculons
# (backspin / scratch arrière) : les indices négatifs sont repliés par le
# modulo, donc ça fonctionne déjà côté serveur.
def audio_callback(outdata, frames, time_info, status):
    global vitesse_actuelle, position_lecture

    indices = position_lecture + np.arange(frames) * vitesse_actuelle
    indices = np.mod(indices, total_frames).astype(int)

    outdata[:] = data_audio[indices]
    position_lecture = (position_lecture + frames * vitesse_actuelle) % total_frames

# --- 5. SERVEUR HTTP ---
class HandlerVitesse(BaseHTTPRequestHandler):
    def do_POST(self):
        global vitesse_actuelle, dernier_paquet_temps, premier_paquet_recu, dernier_ratio_logue, module_lisse

        longueur = int(self.headers.get('Content-Length', 0))
        corps = self.rfile.read(longueur).decode('utf-8').strip()

        try:
            vitesse_recue = float(corps)

            # Lissage : module lissé + signe instantané
            # Snap au relâchement : si on était quasi à l'arrêt (<0.35) et que
            # le ratio saute à ~1.0 (l'app s'est raccrochée à 33.33), on colle
            # directement au lieu de laisser le lissage remonter (~1 s).
            if abs(vitesse_recue) < 0.02:
                module_lisse = 0.0
                vitesse_actuelle = 0.0
            else:
                if module_lisse == 0.0 or (abs(vitesse_recue) > 0.9 and module_lisse < 0.35):
                    module_lisse = abs(vitesse_recue)
                else:
                    module_lisse += (abs(vitesse_recue) - module_lisse) * LISSAGE_ALPHA
                vitesse_actuelle = math.copysign(module_lisse, vitesse_recue)

            dernier_paquet_temps = time.time()

            if not premier_paquet_recu:
                premier_paquet_recu = True
                print("✅ Première requête reçue de l'app. Flux DVS actif.")
            elif dernier_ratio_logue is None or abs(vitesse_recue - dernier_ratio_logue) > 0.01:
                dernier_ratio_logue = vitesse_recue
                print(f"   ratio reçu : {vitesse_recue:+.4f} -> appliqué : {vitesse_actuelle:+.4f}")

            self.send_response(200)
        except ValueError:
            self.send_response(400)

        self.end_headers()

    def log_message(self, format, *args):
        pass

def lancer_serveur_http():
    serveur = HTTPServer((HTTP_IP, HTTP_PORT), HandlerVitesse)
    serveur.serve_forever()

thread_http = threading.Thread(target=lancer_serveur_http, daemon=True)
thread_http.start()

# --- 6. MODE AUTO-TEST : on envoie un POST à soi-même ---
if MODE_TEST:
    import urllib.request
    time.sleep(0.3)
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{HTTP_PORT}/", data=b"0.5000", method="POST")
        rep = urllib.request.urlopen(req, timeout=3)
        print(f"✅ Auto-test OK : le port {HTTP_PORT} répond (HTTP {rep.status}).")
        print("   Si l'app n'envoie rien, le problème est côté téléphone (Wi-Fi/IP).")
    except Exception as e:
        print(f"❌ Auto-test ÉCHEC : {e}")
        print("   Le serveur HTTP n'écoute pas correctement.")
    finally:
        continuer_programme = False
        sys.exit(0)

# --- 7. THREAD DE SÉCURITÉ TIMEOUT + RÉSUMÉ ---
def verifier_timeout_et_logs():
    global vitesse_actuelle, continuer_programme, dernier_paquet_temps
    derniere_activite_log = time.time()
    while continuer_programme:
        now = time.time()
        if not MODE_DEV and (now - dernier_paquet_temps > 0.5):
            if vitesse_actuelle != 0.0:
                vitesse_actuelle = 0.0
                print("[TIMEOUT] Aucun signal reçu de l'app. Son coupé.")
        # Résumé toutes les 5 s : permet de voir si des données arrivent
        if now - derniere_activite_log >= 5.0:
            derniere_activite_log = now
            ecart = now - dernier_paquet_temps
            etat = "FLUX ACTIF" if ecart < 0.5 else "AUCUNE DONNÉE"
            print(f"[{etat}] dernière requête il y a {ecart:.1f}s | vitesse actuelle : {vitesse_actuelle:+.3f}")
        time.sleep(0.1)

thread_check = threading.Thread(target=verifier_timeout_et_logs, daemon=True)
thread_check.start()

# --- 8. BOUCLE PRINCIPALE ---
try:
    with sd.OutputStream(channels=2, callback=audio_callback, samplerate=SAMPLING_RATE, blocksize=1024, device=DEVICE_AUDIO):
        print(f"\n=========================================")
        print(f"===         SERVEUR DVS REKORDBOX       ===")
        print(f"=========================================")
        print(f"Sortie Audio : Device {DEVICE_AUDIO}")
        print(f"IP du serveur : {mon_ip}  <-- à mettre dans tools/speedSender.js de l'app")
        print(f"Port Écoute  : {HTTP_PORT} (HTTP, prêt pour l'app)")
        print(f"Mode actif   : {'🔧 DEV (Clavier + HTTP)' if MODE_DEV else '🚀 PRODUCTION (Silencieux au démarrage)'}")
        print(f"=========================================\n")

        if MODE_DEV:
            print("CONTRÔLES CLAVIER DISPONIBLES :")
            print("  ▲ Flèche HAUT : Accélérer (+0.05)")
            print("  ▼ Flèche BAS  : Ralentir (-0.05)")
            print("  Espace        : Pause / Relancer")
            print("  Contrôle + C  : Éteindre le serveur\n")

            while True:
                key = getkey()
                if key == keys.UP:
                    vitesse_actuelle += 0.05
                    print(f"-> [Clavier] Vitesse : {vitesse_actuelle:.2f}x")
                elif key == keys.DOWN:
                    vitesse_actuelle -= 0.05
                    if vitesse_actuelle < -2.0: vitesse_actuelle = -2.0
                    print(f"-> [Clavier] Vitesse : {vitesse_actuelle:.2f}x")
                elif key == keys.SPACE:
                    if vitesse_actuelle != 0.0:
                        vitesse_actuelle = 0.0
                        print("-> [Clavier] PAUSE")
                    else:
                        vitesse_actuelle = 1.0
                        print("-> [Clavier] LECTURE (1.0x)")
        else:
            print("Mode silencieux actif. En attente du flux de l'application...\n")
            while True:
                time.sleep(1)

except KeyboardInterrupt:
    print("\nFermeture du serveur DVS...")
finally:
    continuer_programme = False
    if zeroconf is not None:
        try:
            zeroconf.unregister_service(info)
            zeroconf.close()
        except Exception:
            pass
    print("Serveur éteint proprement.")
