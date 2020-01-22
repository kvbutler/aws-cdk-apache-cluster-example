#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { ElbApacheServersDemoStack } from '../lib/elb-apache-servers-demo-stack';

const app = new cdk.App();
new ElbApacheServersDemoStack(app, 'ElbApacheServersDemoStack');
