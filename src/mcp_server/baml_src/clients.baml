client<llm> GPT4o {
  provider openai
  options {
    model "gpt-4o"
    api_key env.OPENAI_API_KEY
  }
}

// Phase B document extraction only (document_extract.baml). Temperature 0 for repeatable entity
// extraction; the shared GPT4o client above (podcast/website extraction) is deliberately unchanged.
client<llm> GPT4oExtract {
  provider openai
  options {
    model "gpt-4o"
    api_key env.OPENAI_API_KEY
    temperature 0
  }
}

client<llm> GPT4oMini {
  provider openai
  options {
    model "gpt-4o-mini"
    api_key env.OPENAI_API_KEY
  }
}

retry_policy Constant {
  max_retries 3
  strategy {
    type constant_delay
    delay_ms 200
  }
}