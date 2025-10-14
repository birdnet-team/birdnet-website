import { Routes } from '@angular/router';
import { Analyzer } from './analyzer/analyzer';
import { App } from './app';
import { Home } from './home/home';

export const routes: Routes = [
    {
        path: '',
        component: Home
    },
    {
        path: 'analyzer',
        component: Analyzer
    }
];
