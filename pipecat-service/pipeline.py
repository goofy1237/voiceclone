import os

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.transports.websocket.server import (
    WebsocketServerTransport,
    WebsocketServerParams,
)
from pipecat.services.deepgram.stt import DeepgramSTTService, LiveOptions
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext

from processors.fish_tts import FishAudioTTSService


async def create_pipeline(system_prompt: str):
    """Build the Pipecat pipeline: Deepgram STT -> Claude -> Fish TTS."""

    transport = WebsocketServerTransport(
        host="0.0.0.0",
        port=8765,
        params=WebsocketServerParams(
            audio_in_sample_rate=16000,
            audio_out_sample_rate=44100,
            add_wav_header=True,
            vad_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
            vad_audio_passthrough=True,
        ),
    )

    stt = DeepgramSTTService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        live_options=LiveOptions(
            model="nova-2",
            language="en-AU",
            smart_format=True,
            endpointing=300,
            utterance_end_ms=1000,
            interim_results=True,
        ),
    )

    llm = AnthropicLLMService(
        api_key=os.environ["ANTHROPIC_API_KEY"],
        model="claude-sonnet-4-20250514",
    )
    llm._max_tokens = 200

    tts = FishAudioTTSService(
        api_key=os.environ["FISH_AUDIO_API_KEY"],
        voice_id=os.environ["FISH_VOICE_ID"],
    )

    # Build context with system prompt
    messages = [{"role": "system", "content": system_prompt}]
    context = OpenAILLMContext(messages)
    context_aggregator = llm.create_context_aggregator(context)

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            context_aggregator.user(),
            llm,
            tts,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_connected(transport, client):
        print(f"[pipecat] Client connected")

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport, client):
        print(f"[pipecat] Client disconnected")

    return task, transport
