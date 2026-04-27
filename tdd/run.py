import os
import sys
import subprocess
import glob
import time
from typing import List, Dict

def run_script(script_path: str, env: Dict[str, str]) -> bool:
    """Runs a single test script and returns True if it passes."""
    try:
        print(f"🚀 Running: {os.path.basename(script_path)}...")
        
        # Set PYTHONPATH to root so scripts can find src/mcp_server
        current_env = os.environ.copy()
        current_env.update(env)
        workspace_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        current_env["PYTHONPATH"] = workspace_root + os.pathsep + current_env.get("PYTHONPATH", "")
        
        result = subprocess.run(
            [sys.executable, script_path],
            env=current_env,
            capture_output=True,
            text=True
        )
        
        if result.returncode == 0:
            print(f"✅ PASSED: {os.path.basename(script_path)}")
            if result.stdout.strip():
                # Print just the success line if any
                last_line = result.stdout.strip().split("\n")[-1]
                print(f"   └─ {last_line}")
            return True
        else:
            print(f"❌ FAILED: {os.path.basename(script_path)}")
            print(f"--- ERROR OUTPUT ---\n{result.stderr}\n{result.stdout}\n--------------------")
            return False
            
    except Exception as e:
        print(f"🛑 ERROR executing {script_path}: {str(e)}")
        return False

def main():
    tdd_dir = os.path.dirname(__file__)
    workspace_root = os.path.abspath(os.path.join(tdd_dir, ".."))
    
    # Try to load .env manually to avoid dependency issues in the runner
    env_vars = {}
    env_path = os.path.join(workspace_root, ".env")
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            for line in f:
                if "=" in line and not line.startswith("#"):
                    key, value = line.strip().split("=", 1)
                    env_vars[key] = value

    # Discover scripts
    scripts = sorted(glob.glob(os.path.join(tdd_dir, "verify_*.py")) + 
                    glob.glob(os.path.join(tdd_dir, "test_*.py")))

    if not scripts:
        print("❓ No TDD scripts found in tdd/ directory.")
        return

    print("====================================================")
    print("🛡️  CORTEXDRIVE TDD HEALTH CHECK ORCHESTRATOR")
    print(f"📅 {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("====================================================\n")

    passed_count = 0
    results = []

    for script in scripts:
        success = run_script(script, env_vars)
        results.append((os.path.basename(script), success))
        if success:
            passed_count += 1
        print("")

    print("====================================================")
    print("🏁 FINAL SUMMARY")
    print("====================================================")
    for name, success in results:
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status.ljust(8)} | {name}")
    print("----------------------------------------------------")
    print(f"TOTAL: {passed_count}/{len(scripts)} passed")
    print("====================================================")

    if passed_count < len(scripts):
        sys.exit(1)

if __name__ == "__main__":
    main()
