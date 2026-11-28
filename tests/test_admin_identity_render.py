"""Offline contract for the SSO `admin` login and the Superset local admin (D-ADMIN-1/2).

- keycloak-users seeds `admin` in group `admins` with the same password key as `beluga-admin`.
- Superset's local (provider=db) admin must not share a username with any SSO user, because
  FAB matches OAuth users by username: a shared name would put the SSO login on the local
  account (measured 2026-11-28: SSO `admin` logged in as local row id=1).
- The dashboard-import Job logs in as exactly that local admin.
- Superset scrubs the local password of the legacy `admin` row on every start.
"""
import ast
from pathlib import Path
import re
import shlex
import subprocess

import yaml
from test_dbt_identity_render import container, document

ROOT = Path(__file__).resolve().parents[1]


def render(chart, *extra):
    cmd = ["helm", "template", str(ROOT / "gitops/charts" / chart), *extra]
    return [d for d in yaml.safe_load_all(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout) if d]


def seeded_users(platform):
    source = container(platform, "keycloak-users")["command"][-1]
    tree = ast.parse(source)
    node = next(n for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "USERS")
    users = []
    for entry in node.value.elts:
        item = {}
        for key, value in zip(entry.keys, entry.values):
            if isinstance(value, ast.Constant):
                item[key.value] = value.value
            else:  # os.environ["USER_PASSWORD_*"]
                item[key.value] = ast.unparse(value)
        users.append(item)
    return users


def main():
    full = ["-f", str(ROOT / "gitops/values/sso.yaml"), "-f", str(ROOT / "gitops/values/profile-full.yaml")]
    for name, extra in {"default": [], "full": full}.items():
        users = {u["username"]: u for u in seeded_users(render("beluga-platform", *extra))}
        assert users["admin"]["group"] == "admins", name
        assert users["admin"]["password"] == users["beluga-admin"]["password"] == "os.environ['USER_PASSWORD_ADMIN']", name
        data = render("beluga-data", *extra)
        superset = next(c for c in document(data, "Deployment", "superset")["spec"]["template"]["spec"]["containers"] if c["name"] == "superset")
        script = superset["command"][-1]
        local_admin = re.search(r"fab create-admin --username (\S+)", script).group(1)
        assert local_admin == "superset-admin", (name, local_admin)
        assert local_admin not in users, f"{name}: Superset local admin {local_admin!r} collides with an SSO user"
        # The legacy `admin` row (now the SSO user's) never keeps a known local password.
        assert "superset fab reset-password --username admin " in script, name
        assert script.index("fab create-admin") < script.index("reset-password") < script.index("superset init"), name
        shlex.split(script)  # still a well-formed single shell command
        importer = container(data, "superset-dashboard-import")["command"][-1]
        logins = re.findall(r'"username": "([^"]+)",\s*"password": ADMIN_PASSWORD,\s*(?:#[^\n]*\n\s*)?"provider": "db"', importer)
        assert logins == [local_admin], (name, logins)
        print(f"PASS: {name}: SSO admin seeded in admins; Superset local admin {local_admin} is distinct and used by the import Job")


if __name__ == "__main__":
    main()
