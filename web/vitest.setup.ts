// Runs before every web test file.
//
// React Testing Library only registers its own afterEach cleanup when vitest is
// running with `globals: true`. This project imports its test helpers explicitly
// instead, so without this the DOM from one test is still mounted during the
// next — queries then match elements from a previous render and fail with
// "found multiple elements", which reads like a component bug and isn't one.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);
