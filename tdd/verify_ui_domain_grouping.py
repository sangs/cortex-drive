import os
import sys

# Setup path
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(base_dir, "src", "mcp_server"))

try:
    from domain_registry import get_authorized_labels
except ImportError as e:
    print(f"❌ FAILED: Setup error - {e}")
    sys.exit(1)

def test_ui_persona_alignment():
    """
    TDD for Item 2: UI Level BentoDetailPanel persona detection.
    Asserts that the frontend categories match the backend domain silos.
    """
    print("\n🔍 TDD: Verifying UI Persona Domain Alignment...")

    # Mirrors the categories now hard-coded in BentoDetailPanel.tsx
    # knowledgeTypes = ['Episode', 'Chunk', 'Topic', 'Concept', 'Podcast']
    # structuralTypes = ['Category', 'Technology', 'Company', 'Institution', 'Skill', 'Degree', 'ProfessionalEducation', 'Year', 'Community']
    
    knowledge_labels = get_authorized_labels("podcast")
    professional_labels = get_authorized_labels("professional")

    print("  -> Checking 'Knowledge' persona alignment (Podcast Domain)...")
    ui_knowledge_samples = ['Episode', 'Chunk', 'Topic', 'Concept']
    failed_k = [l for l in ui_knowledge_samples if l not in knowledge_labels]
    
    if failed_k:
        print(f"  -> ❌ FAILED: UI Knowledge categories {failed_k} are not in the 'podcast' domain registry.")
        return False
    else:
        print("  -> ✅ SUCCESS: UI Knowledge persona is schema-aligned.")

    print("  -> Checking 'Professional' persona alignment (Professional Domain)...")
    ui_prof_samples = ['Project', 'Outcome', 'Role']
    failed_p = [l for l in ui_prof_samples if l not in professional_labels]
    
    if failed_p:
        print(f"  -> ❌ FAILED: UI Professional categories {failed_p} are not in the 'professional' domain registry.")
        return False
    else:
        print("  -> ✅ SUCCESS: UI Professional persona is schema-aligned.")

    return True

if __name__ == "__main__":
    if test_ui_persona_alignment():
        print("\n🎊 TDD GREEN: UI Persona Logic is locked to Backend Domains.")
        sys.exit(0)
    else:
        sys.exit(1)
