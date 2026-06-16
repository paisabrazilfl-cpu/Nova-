"""LLM backend abstraction with fail-closed provider adapters.

Provider calls use stdlib urllib to avoid hard dependency bloat. If credentials are
missing, the backend raises LLMError instead of pretending to work.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Protocol

from ..config import Config
from ..exceptions import LLMError
from ..security.redactor import Redactor


@dataclass(slots=True)
class LLMResponse:
    content: str
    model: str | None
    backend: str


class LLMBackend(Protocol):
    def complete(self, prompt: str) -> LLMResponse: ...


class DisabledBackend:
    def complete(self, prompt: str) -> LLMResponse:
        raise LLMError("LLM backend disabled; set AGENT_LLM_BACKEND and credentials to enable")


class EchoBackend:
    """Test backend only. Returns a safe deterministic JSON plan when asked for one."""

    def complete(self, prompt: str) -> LLMResponse:
        try:
            data = json.loads(prompt)
            if "tools" in data:
                content = json.dumps(
                    {
                        "confidence": 0.5,
                        "steps": [
                            {"id": "s1", "kind": "tool", "objective": "inspect status", "tool": "git_status", "args": {}},
                            {"id": "s2", "kind": "verify", "objective": "run verification", "tool": "verify_project", "args": {}},
                        ],
                    }
                )
                return LLMResponse(content=content, model="echo", backend="echo")
        except json.JSONDecodeError:
            pass
        return LLMResponse(content=prompt[-1000:], model="echo", backend="echo")


class _HTTPJSONBackend:
    backend_name = "http"
    default_base_url = ""
    default_model = ""
    auth_header = "Authorization"

    def __init__(self, config: Config):
        self.config = config
        self.redactor = Redactor()
        self.api_key = config.llm.api_key
        self.model = config.llm.model or self.default_model
        self.base_url = (config.llm.base_url or self.default_base_url).rstrip("/")
        if not self.api_key:
            raise LLMError(f"{self.backend_name} backend requires AGENT_LLM_API_KEY")

    def complete(self, prompt: str) -> LLMResponse:
        last_error: Exception | None = None
        for attempt in range(max(1, self.config.llm.retries)):
            try:
                content = self._complete_once(prompt)
                return LLMResponse(content=self.redactor.redact(content), model=self.model, backend=self.backend_name)
            except (urllib.error.URLError, TimeoutError, KeyError, TypeError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt + 1 < self.config.llm.retries:
                    time.sleep(self.config.llm.retry_backoff * (attempt + 1))
        raise LLMError(f"{self.backend_name} request failed: {last_error}")

    def _post(self, url: str, payload: dict[str, object], headers: dict[str, str]) -> dict[str, object]:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", **headers}, method="POST")
        with urllib.request.urlopen(req, timeout=self.config.llm.timeout_seconds) as resp:  # noqa: S310 - configured user endpoint
            data = resp.read().decode("utf-8", errors="replace")
        return json.loads(data)

    def _complete_once(self, prompt: str) -> str:  # pragma: no cover - provider-specific
        raise NotImplementedError


class OpenAIBackend(_HTTPJSONBackend):
    backend_name = "openai"
    default_base_url = "https://api.openai.com/v1"
    default_model = "gpt-4.1-mini"

    def _complete_once(self, prompt: str) -> str:
        data = self._post(
            f"{self.base_url}/chat/completions",
            {
                "model": self.model,
                "temperature": self.config.llm.temperature,
                "max_tokens": self.config.llm.max_tokens,
                "messages": [
                    {"role": "system", "content": "You are an evidence-first coding agent. Return strict JSON when requested."},
                    {"role": "user", "content": prompt},
                ],
            },
            {"Authorization": f"Bearer {self.api_key}"},
        )
        return str(data["choices"][0]["message"]["content"])  # type: ignore[index]


class AnthropicBackend(_HTTPJSONBackend):
    backend_name = "anthropic"
    default_base_url = "https://api.anthropic.com/v1"
    default_model = "claude-3-5-sonnet-latest"

    def _complete_once(self, prompt: str) -> str:
        data = self._post(
            f"{self.base_url}/messages",
            {
                "model": self.model,
                "max_tokens": self.config.llm.max_tokens,
                "temperature": self.config.llm.temperature,
                "system": "You are an evidence-first coding agent. Return strict JSON when requested.",
                "messages": [{"role": "user", "content": prompt}],
            },
            {"x-api-key": str(self.api_key), "anthropic-version": "2023-06-01"},
        )
        parts = data.get("content", [])
        if isinstance(parts, list):
            return "".join(str(p.get("text", "")) for p in parts if isinstance(p, dict))
        return str(parts)


class MistralBackend(_HTTPJSONBackend):
    backend_name = "mistral"
    default_base_url = "https://api.mistral.ai/v1"
    default_model = "mistral-large-latest"

    def _complete_once(self, prompt: str) -> str:
        data = self._post(
            f"{self.base_url}/chat/completions",
            {
                "model": self.model,
                "temperature": self.config.llm.temperature,
                "max_tokens": self.config.llm.max_tokens,
                "messages": [
                    {"role": "system", "content": "You are an evidence-first coding agent. Return strict JSON when requested."},
                    {"role": "user", "content": prompt},
                ],
            },
            {"Authorization": f"Bearer {self.api_key}"},
        )
        return str(data["choices"][0]["message"]["content"])  # type: ignore[index]


class SupernovaSwarmBackend(_HTTPJSONBackend):
    """NEWSUPERNOVA / SUPERNOVA agent swarm.

    The swarm exposes an OpenAI-compatible endpoint, so the wire format is
    identical to OpenAIBackend: POST {base_url}/chat/completions with Bearer
    auth, reading choices[0].message.content. Point `model` at an agent name
    (abby = orchestrator; also forge/crawler/vault/wire/mr.nice). The API key
    is the swarm's OPENCLAW_API_KEY, supplied via AGENT_LLM_API_KEY — never
    hardcoded here.
    """

    backend_name = "swarm"
    default_base_url = "https://supernova.onrender.com/api/external/v1"
    default_model = "abby"

    def _complete_once(self, prompt: str) -> str:
        data = self._post(
            f"{self.base_url}/chat/completions",
            {
                "model": self.model,
                "temperature": self.config.llm.temperature,
                "max_tokens": self.config.llm.max_tokens,
                "messages": [
                    {"role": "system", "content": "You are an evidence-first coding agent. Return strict JSON when requested."},
                    {"role": "user", "content": prompt},
                ],
            },
            {"Authorization": f"Bearer {self.api_key}"},
        )
        return str(data["choices"][0]["message"]["content"])  # type: ignore[index]


class RouterBackend:
    """Try several AI providers in order. First successful response wins."""

    def __init__(self, backends: list[LLMBackend]):
        self.backends = backends

    def complete(self, prompt: str) -> LLMResponse:
        errors: list[str] = []
        for backend in self.backends:
            try:
                return backend.complete(prompt)
            except LLMError as exc:
                errors.append(str(exc))
        raise LLMError("all routed LLM backends failed: " + " | ".join(errors))


def build_backend(config: Config) -> LLMBackend:
    backend = config.llm.backend.lower()
    if backend in {"disabled", "none", "off", "auto"}:
        return DisabledBackend()
    if backend == "echo":
        return EchoBackend()
    if backend == "openai":
        return OpenAIBackend(config)
    if backend == "anthropic":
        return AnthropicBackend(config)
    if backend == "mistral":
        return MistralBackend(config)
    if backend in {"swarm", "supernova", "newsupernova"}:
        return SupernovaSwarmBackend(config)
    if backend in {"router", "multi", "moe"}:
        # Deliberately conservative: each provider still needs credentials/base URL.
        candidates: list[LLMBackend] = []
        for name in ("openai", "anthropic", "mistral"):
            cfg = Config.load(overrides={**config.to_dict(), "llm": {**config.to_dict()["llm"], "backend": name}})
            try:
                candidates.append(build_backend(cfg))
            except LLMError:
                continue
        if not candidates:
            raise LLMError("router backend has no configured providers")
        return RouterBackend(candidates)
    raise LLMError(f"Unsupported LLM backend: {config.llm.backend}")
