# Tested models

[← README](../README.md)

Models Reika has been run against, in daily use and in evaluations. Reika was designed around local
models, and both kinds get used and tested: local quants are where most of the behavior work is
measured, and API models also show what a local quant can and can't hold by comparison.

The quantization is in parentheses. Where a note names modes, those are the modes the model was used
in, not the only ones it can handle.

The 4B-class models at the bottom of the local list run end to end, but struggle with anything past a
few steps. Use them for short, well-scoped tasks.

## Local

- LFM2.5 24B A2B (UD-IQ3_XXS)
- Mellum2.1 12B A2.5B Thinking (Q4_K_M)
- Ling 3.0 Tiny (Q4_K_M)
- Qwen3.8 Flash Next (UD-IQ3_XXS; chat mode; minimal mode; via SSD streaming)
- DeepSeek V4 Flash 0731 (UD-IQ3_XXS; chat mode; minimal mode; via SSD streaming)
- Muse Glimmer 30B (IQ3_XXS)
- Qwen3.8 27B (UD-IQ3_XXS)
- Qwen3.6 35B A3B (UD-IQ2_M)
- Qwen3.6 35B A3B (UD-IQ2_XXS)
- Ornith 1.0 35B (UD-IQ2_M)
- Laguna XS 2.1 (IQ2_M)
- KAT Coder V2.5 Dev (IQ2_M)
- North Mini Code 1.0 (UD-IQ3_XXS)
- Gemma 4 26B A4B IT (UD-IQ3_XXS)
- GPT-OSS 20B (MXFP4 Q4_K_M)
- Ornith 1.5 9B (Q5_K_M)
- Qwen3.5 9B (MLX Q4)
- LFM2.5 8B A1B (MLX Q4)
- Granite 4.1 8B (MLX Q4)
- Spark X2.6 4B (Q8_0)
- Gemma 4 E4B IT (MLX Q4)

## API

- MiMo V2.6 Pro (OpenCode Go)
- MiMo V2.6 Flash (OpenCode Go)
- GLM 5.3 Flash (OpenCode Go)
- DeepSeek V4.1 Flash (OpenCode Go)
- GLM 5.2 (OpenRouter, OpenCode Go)
- Kimi K3 (MoonshotAI)
- Kimi K2.6 (MoonshotAI)
- Kimi K2.5 (MoonshotAI, OpenRouter)
- DeepSeek V4 Flash (OpenRouter, OpenCode Go)
- Laguna XS 2.1 (OpenRouter)
- Laguna M.1 (OpenRouter)
- StepFun 3.5 Flash (OpenRouter, NVIDIA NIM)
- StepFun 3.7 Flash (NVIDIA NIM)
