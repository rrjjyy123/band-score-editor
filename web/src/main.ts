import './style.css';
import { App } from './app';

const app = new App();
// 개발할 때 콘솔에서 살펴볼 수 있게
(window as unknown as { app: App }).app = app;
