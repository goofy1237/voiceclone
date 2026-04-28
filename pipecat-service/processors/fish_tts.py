from typing import AsyncGenerator

import httpx
from pipecat.services.tts_service import TTSService
from pipecat.frames.frames import (
    Frame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSAudioRawFrame,
    ErrorFrame,
)


class FishAudioTTSService(TTSService):
    """Fish Audio TTS via their REST API, compatible with Pipecat's TTSService."""

    def __init__(
        self,
        *,
        api_key: str,
        voice_id: str,
        sample_rate: int = 44100,
        **kwargs,
    ):
        super().__init__(sample_rate=sample_rate, **kwargs)
        self._api_key = api_key
        self._voice_id = voice_id
        self._sample_rate = sample_rate
        # Suppress settings warnings
        if hasattr(self, '_settings'):
            for field in ('model', 'voice', 'language'):
                if hasattr(self._settings, field):
                    try:
                        setattr(self._settings, field, None)
                    except Exception:
                        pass

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        """Yield TTS audio frames from Fish Audio API."""
        if not text or not text.strip():
            return

        yield TTSStartedFrame()

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    "https://api.fish.audio/v1/tts",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "text": text,
                        "reference_id": self._voice_id,
                        "format": "pcm",
                        "latency": "balanced",
                        "streaming": True,
                    },
                )

                if resp.status_code != 200:
                    err = resp.text[:200]
                    print(f"[fish-tts] Error {resp.status_code}: {err}")
                    # Retry with mp3
                    resp = await client.post(
                        "https://api.fish.audio/v1/tts",
                        headers={
                            "Authorization": f"Bearer {self._api_key}",
                            "Content-Type": "application/json",
                        },
                        json={
                            "text": text,
                            "reference_id": self._voice_id,
                            "format": "mp3",
                            "latency": "balanced",
                        },
                    )
                    if resp.status_code != 200:
                        print(f"[fish-tts] MP3 fallback failed: {resp.status_code}")
                        yield ErrorFrame(f"Fish TTS error: {resp.status_code}")
                        yield TTSStoppedFrame()
                        return

                audio_data = resp.content
                print(f"[fish-tts] Got {len(audio_data)} bytes for: {text[:50]}...")
                chunk_size = 4096
                for i in range(0, len(audio_data), chunk_size):
                    chunk = audio_data[i : i + chunk_size]
                    yield TTSAudioRawFrame(
                        audio=chunk,
                        sample_rate=self._sample_rate,
                        num_channels=1,
                    )

        except Exception as e:
            print(f"[fish-tts] Exception: {e}")
            yield ErrorFrame(str(e))

        yield TTSStoppedFrame()
