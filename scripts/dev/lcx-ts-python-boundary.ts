import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type PythonRole = "keep_python_engine" | "wrap_with_ts_owner" | "migrate_to_ts_control";

type PythonFilePolicy = {
  path: string;
  role: PythonRole;
  plainRole: "保留" | "包装" | "迁走";
  reason: string;
  targetTsOwner?: string;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(SCRIPT_DIR, "..", "..");
const execFileAsync = promisify(execFile);

const PYTHON_POLICIES: Record<string, Omit<PythonFilePolicy, "path">> = {
  "evals/local-brain/inspect_local_brain.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "本地模型/权重检查属于发动机层，TS 只负责调度和验收。",
    targetTsOwner: "scripts/dev/local-brain-training-plan.ts",
  },
  "skills/nano-banana-pro/scripts/generate_image.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "图片生成技能脚本属于外部工具发动机，不应变成主流程控制器。",
  },
  "skills/openai-image-gen/scripts/gen.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "图片生成技能脚本属于外部工具发动机，不应变成主流程控制器。",
  },
  "skills/openai-image-gen/scripts/test_gen.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "图片生成技能测试跟随技能发动机保留。",
  },
  "skills/model-usage/scripts/model_usage.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "模型用量读取是独立工具发动机，不能持有 LCX 主流程权力。",
  },
  "skills/model-usage/scripts/test_model_usage.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "模型用量工具测试跟随工具发动机保留。",
  },
  "skills/skill-creator/scripts/init_skill.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "技能创建工具属于独立工具发动机，不是 LCX 主流程控制。",
  },
  "skills/skill-creator/scripts/package_skill.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "技能打包工具属于独立工具发动机，不是 LCX 主流程控制。",
  },
  "skills/skill-creator/scripts/quick_validate.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "技能校验工具属于独立工具发动机，不是 LCX 主流程控制。",
  },
  "skills/skill-creator/scripts/test_package_skill.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "技能打包测试跟随技能工具发动机保留。",
  },
  "skills/skill-creator/scripts/test_quick_validate.py": {
    role: "keep_python_engine",
    plainRole: "保留",
    reason: "技能校验测试跟随技能工具发动机保留。",
  },
  "lobster_orchestrator.py": {
    role: "wrap_with_ts_owner",
    plainRole: "包装",
    reason: "这是旧主控入口，暂时可用，但以后必须由 TS 主控调用，不能继续扩权。",
    targetTsOwner: "scripts/dev/lcx-system-doctor.ts",
  },
  "daily_learning_runner.py": {
    role: "wrap_with_ts_owner",
    plainRole: "包装",
    reason: "这是旧学习流程入口，暂时可用，但学习流程决策应回到 TS 主控。",
    targetTsOwner: "scripts/dev/lcx-governance-autopilot.ts",
  },
  "scripts/lobster_paths.py": {
    role: "wrap_with_ts_owner",
    plainRole: "包装",
    reason: "这是旧路径辅助，迁完前只能被 TS 路径主人包住使用。",
    targetTsOwner: "scripts/dev/lcx-local-paths.ts",
  },
  "scripts/lobster_host_watchdog.py": {
    role: "wrap_with_ts_owner",
    plainRole: "包装",
    reason: "这是旧看门脚本，运行决策和告警边界应由 TS owner 管。",
    targetTsOwner: "scripts/dev/lcx-system-doctor.ts",
  },
  "scripts/branch_freshness.py": {
    role: "migrate_to_ts_control",
    plainRole: "迁走",
    reason: "分支新旧判断是流程控制，不是训练/计算发动机，应该迁到 TS。",
    targetTsOwner: "scripts/dev/lcx-change-impact-plan.ts",
  },
  "scripts/check-composite-action-input-interpolation.py": {
    role: "migrate_to_ts_control",
    plainRole: "迁走",
    reason: "CI 字符串检查是流程控制，不是训练/计算发动机，应该迁到 TS。",
    targetTsOwner: "scripts/dev/lcx-change-impact-plan.ts",
  },
};

function parseArgs(args: string[]) {
  const options = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("Usage: node --import tsx scripts/dev/lcx-ts-python-boundary.ts [--json]");
    } else {
      throw new Error("Usage: node --import tsx scripts/dev/lcx-ts-python-boundary.ts [--json]");
    }
  }
  return options;
}

async function listPythonFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((file) => file.endsWith(".py") || file.endsWith(".pyi"))
    .toSorted();
}

function classifiedPolicies(files: readonly string[]): PythonFilePolicy[] {
  return files
    .filter((file) => PYTHON_POLICIES[file])
    .map((file) => ({ path: file, ...PYTHON_POLICIES[file] }));
}

function groupByRole(policies: readonly PythonFilePolicy[]) {
  return {
    keep: policies.filter((policy) => policy.role === "keep_python_engine"),
    wrap: policies.filter((policy) => policy.role === "wrap_with_ts_owner"),
    migrate: policies.filter((policy) => policy.role === "migrate_to_ts_control"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pythonFiles = await listPythonFiles();
  const policies = classifiedPolicies(pythonFiles);
  const unknownFiles = pythonFiles.filter((file) => !PYTHON_POLICIES[file]);
  const stalePolicies = Object.keys(PYTHON_POLICIES).filter((file) => !pythonFiles.includes(file));
  const classification = groupByRole(policies);
  const result = {
    ok: unknownFiles.length === 0,
    boundary: "dev_ts_python_boundary_only",
    checkedAt: new Date().toISOString(),
    ruleInPlainChinese:
      "以后 TS 管流程，Python 只做训练、MLX、数据计算这些发动机活；旧 Python 要么被 TS 包住，要么迁到 TS。",
    summary: {
      pythonFiles: pythonFiles.length,
      keep: classification.keep.length,
      wrap: classification.wrap.length,
      migrate: classification.migrate.length,
      unknown: unknownFiles.length,
      stalePolicyEntries: stalePolicies.length,
    },
    rules: [
      "TS owns routing, orchestration, safety gates, reporting, governance, and user-visible flow.",
      "Python may remain for training, MLX/model execution, numerical/data computation, and isolated skill engines.",
      "A Python file that controls workflow must be wrapped by a named TS owner or migrated to TS.",
      "Any new Python file must be added to this check before it can be treated as acceptable.",
    ],
    classification,
    unknownFiles,
    stalePolicies,
    violations: unknownFiles.map((file) => ({
      path: file,
      reason: "new_python_file_must_choose_keep_wrap_or_migrate",
    })),
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };

  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `TS/Python boundary ${result.ok ? "ok" : "failed"}`,
          result.ruleInPlainChinese,
          `保留=${result.summary.keep} 包装=${result.summary.wrap} 迁走=${result.summary.migrate} 未归类=${result.summary.unknown}`,
          ...unknownFiles.map((file) => `- 未归类: ${file}`),
        ].join("\n") + "\n",
  );
  process.exitCode = result.ok ? 0 : 1;
}

await main();
