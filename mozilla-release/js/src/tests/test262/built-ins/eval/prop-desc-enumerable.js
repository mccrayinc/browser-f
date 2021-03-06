// Copyright 2009 the Sputnik authors.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
info: The eval property has the attribute DontEnum
esid: sec-eval-x
description: Checking use propertyIsEnumerable, for-in
---*/

//CHECK#1
if (this.propertyIsEnumerable('eval') !== false) {
  $ERROR('#1: this.propertyIsEnumerable(\'eval\') === false. Actual: ' + (this.propertyIsEnumerable('eval')));
}

//CHECK#2
var result = true;
for (var p in this) {
  if (p === "eval") {
    result = false;
  }
}

if (result !== true) {
  $ERROR('#2: result = true; for (p in this) { if (p === "eval") result = false; }  result === true;');
}

reportCompare(0, 0);
