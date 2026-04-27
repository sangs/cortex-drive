import sys
import os
import json

# Add src/mcp_server to path
sys.path.append(os.path.abspath("src/mcp_server"))

try:
    from schema_guard import BACKBONE_LANDMARKS
    from domain_registry import DOMAIN_REGISTRY, get_authorized_labels
    print("SUCCESS: Imports for Domain Sovereignty are valid.")
    print(f"Landmarks: {BACKBONE_LANDMARKS}")
except ImportError as e:
    print(f"FAILURE: Import error - {e}")
    sys.exit(1)

def verify_silos():
    prof_labels = get_authorized_labels("professional")
    podcast_labels = get_authorized_labels("podcast")
    
    # Assert isolation
    if "Podcast" in prof_labels:
        print("FAILURE: Podcast leaked into professional silo!")
    elif "Company" in podcast_labels:
        print("FAILURE: Company leaked into podcast silo!")
    else:
        print("SUCCESS: Domain silos are strictly isolated.")

def verify_landmarks():
    reqs = ["Company", "Startup", "Hackathon", "ThoughtLeadership"]
    missing = [r for r in reqs if r not in BACKBONE_LANDMARKS]
    if missing:
        print(f"FAILURE: Missing backbone landmarks: {missing}")
    else:
        print("SUCCESS: All requested landmarks are in the authoritative registry.")

if __name__ == "__main__":
    verify_silos()
    verify_landmarks()
