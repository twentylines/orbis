const assert = require('node:assert/strict');

async function measure(page, rootSelector) {
  return page
    .locator(rootSelector)
    .first()
    .evaluate((root) => {
      const context = document.createElement('canvas').getContext('2d');
      return [...root.querySelectorAll('input[placeholder]')]
        .filter((input) => input.placeholder && input.getClientRects().length && getComputedStyle(input).visibility !== 'hidden')
        .map((input) => {
          const style = getComputedStyle(input);
          const placeholder = getComputedStyle(input, '::placeholder');
          context.font = `${placeholder.fontStyle} ${placeholder.fontWeight} ${placeholder.fontSize} ${placeholder.fontFamily}`;
          const spacing = Number.parseFloat(placeholder.letterSpacing) || 0;
          return {
            name: input.name || input.id || input.getAttribute('aria-label'),
            text: input.placeholder,
            textWidth: context.measureText(input.placeholder).width + Math.max(0, Array.from(input.placeholder).length - 1) * spacing,
            available:
              input.clientWidth -
              Number.parseFloat(style.paddingLeft) -
              Number.parseFloat(style.paddingRight) -
              Math.max(0, Number.parseFloat(style.textIndent) || 0),
          };
        });
    });
}

function check(fields) {
  for (const field of fields) {
    assert.ok(Number.isFinite(field.textWidth) && Number.isFinite(field.available), 'Placeholder measurement must be finite');
    assert.ok(field.textWidth + 8 <= field.available, 'The complete field placeholder must fit with caret clearance');
  }
}

module.exports = { measure, check };
