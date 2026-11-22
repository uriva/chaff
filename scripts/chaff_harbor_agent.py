import json
import os
from pathlib import Path
import shlex
from typing import override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

LOCAL_BINARY_PATH = Path("/tmp/opencode/chaff-tb41/chaff-agent")
REMOTE_BINARY_PATH = "/usr/local/bin/chaff-agent"
TRAJECTORY_REMOTE_PATH = "/logs/agent/trajectory.json"
OUTPUT_REMOTE_LOG = "/logs/agent/chaff-agent.txt"


class ChaffAgent(BaseInstalledAgent):
    """Harbor adapter for the chaff agent harness."""

    capabilities = AgentCapabilities(atif=False, resume=False)
    MODEL_CONNECTION = ModelConnectionSpec(
        default_provider="google",
        api_key_envs=("GEMINI_API_KEY",),
        passthrough=True,
    )

    @classmethod
    def name(cls) -> str:
        return "chaff"

    def get_version_command(self) -> str | None:
        return "echo 0.4.3"

    def parse_version(self, stdout: str) -> str:
        return stdout.strip() or "0.4.3"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not LOCAL_BINARY_PATH.exists():
            raise FileNotFoundError(f"Agent binary not found at {LOCAL_BINARY_PATH}")
        await environment.upload_file(LOCAL_BINARY_PATH, REMOTE_BINARY_PATH)
        await self.exec_as_root(environment, command=f"chmod +x {REMOTE_BINARY_PATH}")
        await self.exec_as_root(
            environment, command="mkdir -p /logs/agent && chmod 777 /logs/agent"
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        gemini_key = os.environ.get("GEMINI_API_KEY") or self._extra_env.get("GEMINI_API_KEY")
        if not gemini_key:
            raise ValueError("GEMINI_API_KEY environment variable required")

        env = {"GEMINI_API_KEY": gemini_key}
        if self._extra_env:
            env.update(self._extra_env)

        model = self.model_name or "google/gemini-4-hydrogen"
        cmd = (
            f"{REMOTE_BINARY_PATH} "
            f"--task {shlex.quote(instruction)} "
            f"--model {shlex.quote(model)} "
            f"--thinking high "
            f"--output {TRAJECTORY_REMOTE_PATH} "
            f"</dev/null > {OUTPUT_REMOTE_LOG} 2>&1"
        )
        await self.exec_as_agent(environment, command=cmd, env=env)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        for candidate in (
            self.logs_dir / "agent" / "trajectory.json",
            self.logs_dir / "trajectory.json",
        ):
            if candidate.exists():
                data = json.loads(candidate.read_text())
                usage = data.get("usage", {})
                context.n_input_tokens = usage.get("promptTokens", 0)
                context.n_output_tokens = (
                    usage.get("candidatesTokens", 0) + usage.get("thoughtsTokens", 0)
                )
                context.n_cache_tokens = usage.get("cachedTokens", 0)
                return
