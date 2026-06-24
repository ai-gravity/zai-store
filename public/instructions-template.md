# GLM 5.2 API Key

เอกสารสำหรับส่งมอบ API key สำหรับใช้งานโมเดล `glm-5.2`

## รายละเอียดบริการ

- Provider: Z.ai / GLM
- Model หลัก: `glm-5.2`
- Endpoint แบบ Anthropic-compatible:

```text
https://api.z.ai/api/anthropic
```

- Key:

```text
{{API_KEY}}
```

## การตั้งค่าบน zsh

เพิ่มคำสั่งนี้ลงในไฟล์ `~/.zshrc`

```zsh
claude-glm() {
  ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" \
  ANTHROPIC_AUTH_TOKEN="{{API_KEY}}" \
  ANTHROPIC_MODEL="glm-5.2" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.2" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5-turbo" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="GLM-4.7" \
  ANTHROPIC_SMALL_FAST_MODEL="GLM-4.5-Air" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" \
  CLAUDE_CODE_EFFORT_LEVEL="max" \
  command claude "$@"
}
```

หลังจากแก้ไฟล์แล้ว ให้โหลดค่าใหม่ด้วยคำสั่ง:

```zsh
source ~/.zshrc
```

จากนั้นเรียกใช้งานด้วย:

```zsh
claude-glm
```

## ตัวแปรสำหรับตั้งค่าแบบแยก

หากต้องการตั้งค่าเป็น environment variables โดยตรง:

```zsh
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
export ANTHROPIC_AUTH_TOKEN="{{API_KEY}}"
export ANTHROPIC_MODEL="glm-5.2"
```

## Models ที่แนะนำ

| ประเภท | Model |
|---|---|
| Main / Opus | `glm-5.2` |
| Sonnet | `glm-5-turbo` |
| Haiku | `GLM-4.7` |
| Small fast | `GLM-4.5-Air` |

## หมายเหตุ

- API key เป็นข้อมูลส่วนตัว ห้ามเผยแพร่ต่อสาธารณะ
- หาก key ใช้งานไม่ได้ ให้ตรวจสอบว่าใส่ค่า `ANTHROPIC_AUTH_TOKEN` ถูกต้อง
- Endpoint นี้เป็นแบบ Anthropic-compatible จึงเหมาะสำหรับเครื่องมือที่รองรับตัวแปร `ANTHROPIC_BASE_URL`
