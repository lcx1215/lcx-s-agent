---
summary: "Skills directory: where skills live and how to add them"
read_when:
  - Introducing the skills directory to new users
  - Adding, sharing, or backing up skills
  - Explaining skill load order
title: "Skills directory"
---

# Skills directory

A skill is just a folder with a `SKILL.md` file (plus supporting text files). LCX Agent ships a
set of bundled skills in the repository `skills/` directory and loads any additional skill folder
you drop into one of the skill roots below.

Browse the bundled skills: [skills/](https://github.com/lcx1215/lcx-s-agent/tree/main/skills)

## Where skills live

Skills are loaded from four places, highest precedence first:

1. `<workspace>/skills` — skills for one project.
2. `~/.openclaw/skills` — skills shared by every agent on this machine.
3. **Bundled** skills shipped with the install.
4. `skills.load.extraDirs` — extra directories configured in `~/.openclaw/openclaw.json`
   (lowest precedence).

The macOS app also has a Skills UI. On Linux and headless installs, copy the folder instead.

## Adding a skill

- Add a skill to your workspace (loaded on the next session):

  ```bash
  mkdir -p ./skills
  cp -R <skill-folder> ./skills/<skill-name>
  ```

- Share a skill across every agent on this machine:

  ```bash
  mkdir -p ~/.openclaw/skills
  cp -R <skill-folder> ~/.openclaw/skills/<skill-name>
  ```

Skills placed in `./skills` under your current working directory are loaded as
`<workspace>/skills` on the next session.

## Backing up your skills

Your own skills are plain folders, so any normal backup works — copy `./skills` and
`~/.openclaw/skills` somewhere safe, or keep them in a git repository. To contribute a skill
upstream, open a pull request against the repository `skills/` directory.

## Security notes

- Treat third-party skills as **untrusted code**. Read them before enabling.
- Prefer sandboxed runs for untrusted inputs and risky tools. See [Sandboxing](/gateway/sandboxing).
