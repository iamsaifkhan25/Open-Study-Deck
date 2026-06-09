import fs from 'fs';
import postcss from 'postcss';

const cssContent = fs.readFileSync('style.css', 'utf8');

postcss()
  .process(cssContent, { from: 'style.css' })
  .then((result) => {
    console.log('PostCSS parse success! Warnings count:', result.warnings().length);
    result.warnings().forEach((warn) => {
      console.warn(warn.toString());
    });
  })
  .catch((error) => {
    console.error('PostCSS parse failed:');
    console.error(error.message);
    if (error.line) {
      console.error(`Line: ${error.line}, Column: ${error.column}`);
    }
  });
