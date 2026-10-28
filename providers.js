// Shared by trusted extension pages and the service worker.
const WriteWiseProviders = Object.freeze({
  openai: {
    name:'OpenAI', model:'gpt-5.4-mini', modelLabel:'GPT-5.4 mini',
    endpoint:'https://api.openai.com/v1/chat/completions',
    keyUrl:'https://platform.openai.com/api-keys', keyDomain:'platform.openai.com'
  },
  deepseek: {
    name:'DeepSeek', model:'deepseek-flash', modelLabel:'DeepSeek Flash',
    endpoint:'https://api.deepseek.com/chat/completions',
    keyUrl:'https://platform.deepseek.com/api_keys', keyDomain:'platform.deepseek.com'
  }
});
const WriteWiseConsentVersion = 3;
const WriteWiseLanguages = Object.freeze({en:'English', pl:'Polish', ru:'Russian', uk:'Ukrainian'});
