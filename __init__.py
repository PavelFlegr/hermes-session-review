"""Agent half of session-review: registers the workflow skill; routes live in dashboard/, UI in desktop/."""
from pathlib import Path


def register(ctx):
    skills_dir = Path(__file__).parent / "skills"
    for skill_dir in sorted(skills_dir.iterdir()):
        skill_file = skill_dir / "SKILL.md"
        if skill_dir.is_dir() and skill_file.exists():
            ctx.register_skill(skill_dir.name, skill_file)
