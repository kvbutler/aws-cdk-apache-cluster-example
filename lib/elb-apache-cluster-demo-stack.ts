import * as cdk from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as autoscaling from '@aws-cdk/aws-autoscaling';
import * as s3 from '@aws-cdk/aws-s3';
import * as cw from '@aws-cdk/aws-cloudwatch';

/**
 * This stack serves as an example of three Apache web servers behind an ELB, and cdk usage itself
 * 
 * NOTE: this stack should not be used in production, this is merely a demonstration of concepts
 */
export class ElbApacheClusterDemoStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create log bucket
    const logBucket = new s3.Bucket(this, 'WebLogBucket');

    // Get default VPC
    const vpc = ec2.Vpc.fromLookup(this, 'VPC', { isDefault: true });

    // Get the VPC's public subnets distinct by AZ
    const distinctAzPublicSubnets = Object.values(
      vpc.publicSubnets
      .reduce((map: {[key: string]: ec2.ISubnet}, subnet) => { 
        map[subnet.availabilityZone] = subnet; 
        return map; 
      }, {})
    );

    // Pull the standard Amazon Linux 2 AMI
    const amznLinuxAmi = new ec2.AmazonLinuxImage({
      generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      edition: ec2.AmazonLinuxEdition.STANDARD,
      virtualization: ec2.AmazonLinuxVirt.HVM,
      storage: ec2.AmazonLinuxStorage.GENERAL_PURPOSE,
    });

    // User data script, this script will be run on each ec2 instance upon launch
    const userData = ec2.UserData.forLinux();
    userData.addCommands(...[
      'yum update -y',
      'yum install -y jq',
      'yum install -y httpd',
      'yum install -y awslogs',
      'export host_name=$(curl http://169.254.169.254/latest/meta-data/local-hostname)',
      'export instance_id=$(curl http://169.254.169.254/latest/meta-data/instance-id)',
      'export identity_document=$(curl http://169.254.169.254/latest/dynamic/instance-identity/document)',
      'export az=$(echo $identity_document | jq -r .availabilityZone)',
      'echo "<html><head><link rel=\\"stylesheet\\" href=\\"https://cdn.jsdelivr.net/gh/kognise/water.css@latest/dist/dark.min.css\\"></head><body><h3>Hello from $host_name ($instance_id) in AZ $az.</h3><p>Instance Details:</p><p><code style=\\"line-height: 1.8\\">$identity_document</code></body></html></p>" > /var/www/html/index.html',
      'systemctl start httpd',
      'chkconfig httpd on',
      'systemctl start awslogsd',
      'chkconfig awslogsd on',
    ]);
    userData.render();

    // Instance role
    const asgInstanceRole = new iam.Role(this, 'WebLogRole', {
      assumedBy: new iam.ServicePrincipal('ec2'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess')],
    })

    // ASG
    const asg = new autoscaling.AutoScalingGroup(this, 'WebASG', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: amznLinuxAmi,
      userData: userData,
      minCapacity: 3,
      maxCapacity: 6,
      vpcSubnets: vpc.selectSubnets({
        subnets: distinctAzPublicSubnets,
      }),
      role: asgInstanceRole,
    });
    // Scale when CPU utilization reaches 80% or higher
    asg.scaleOnCpuUtilization('WebASGScaleOnCpuMetric', {
      targetUtilizationPercent: 80,
    });

    // Application ELB
    const lb = new elbv2.ApplicationLoadBalancer(this, 'WebELB', {
      vpc,
      internetFacing: true,
      vpcSubnets: vpc.selectSubnets({
        subnets: distinctAzPublicSubnets,
      }),
    });
    // Configure logging and alarm
    lb.logAccessLogs(logBucket, 'elbAccessLogs');
    lb.metric('HTTPCode_ELB_5XX_Count', {
      statistic: 'sum'
    }).createAlarm(this, 'WebELB5XX', {
      threshold: 10,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
    })

    // Configure ELB listener
    const listener = lb.addListener('WebListener', {
      port: 80,
    });
    listener.addTargets('WebTarget', {
      port: 80,
      targets: [asg],
    });
    listener.connections.allowDefaultPortFromAnyIpv4('Open to the world (ALLOW 80 0.0.0.0/0,::0)');
  }
}
