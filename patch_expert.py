import re

with open("expert_tools.py", "r") as f:
    content = f.read()

# 1. Update __init__
content = re.sub(
    r'def __init__\(self\):',
    r'def __init__(self, tenant_id: str):\n        self.tenant_id = tenant_id',
    content
)

# 2. Add tenant_id parameter to execute_query
content = re.sub(
    r'(execute_query\([^,]+, )',
    r'\1tenant_id=self.tenant_id, ',
    content
)

# Replace execute_query calls that don't have existing kwargs yet
# Careful to only match execute_query(query) without touching method params
content = re.sub(
    r'(execute_query\([^\)]+\))',
    lambda m: m.group(1).replace(')', ', tenant_id=self.tenant_id)') if ',' not in m.group(1).split('execute_query(')[1] else m.group(1),
    content
)

# 3. Update query strings to attach where clauses
# For match clauses
content = re.sub(
    r'MATCH \(([a-z]+):Episode\)',
    r'MATCH (\1:Episode {tenant_id: $tenant_id})',
    content
)

with open("expert_tools.py", "w") as f:
    f.write(content)

print("Patch applied.")
