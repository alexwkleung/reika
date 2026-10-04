# Tested models

[← README](../README.md)

Models Reika has been run against, in daily use and in evaluations. Local models are what Reika was
designed around, and where the behaviour work is tested. Day-to-day use is mostly on API models,
which also serve as the comparison for what a local quant can and cannot hold.

Quantization is the one in parentheses. Where a note names modes, that is where the model was used
rather than the only thing it can do.

## Local

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
