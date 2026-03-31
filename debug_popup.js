const fs = require('fs');
const js = fs.readFileSync('popup.js', 'utf8');
const html = fs.readFileSync('popup.html', 'utf8');
const ids = [...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
const missingIds = ids.filter(id => !html.includes('id="'+id+'"') && !html.includes("id='"+id+"'"));
console.log('Missing IDs accessed in JS: ', [...new Set(missingIds)]);
