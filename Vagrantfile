# -*- mode: ruby -*-
# vi: set ft=ruby :

# Beluga Vagrantfile
# D1: Subnet 192.168.77.x (Mapped directly to VMware Fusion vmnet12)
# D2: Single Master (master-1) + 3 Workers (worker-1..3)
# D8: Dynamic RAM Sizing via configs/cluster.env

require 'yaml'

config_file = File.expand_path('../configs/cluster.env', __FILE__)
env_vars = {}
if File.exist?(config_file)
  File.readlines(config_file).each do |line|
    line.strip!
    next if line.empty? || line.start_with?('#')
    key, value = line.split('=', 2)
    env_vars[key] = value.gsub(/\A"|"\Z/, '') if key && value
  end
end

subnet = env_vars['SUBNET_PREFIX'] || '192.168.77'
box_name = env_vars['BOX_NAME'] || 'dasomel/ubuntu-26.04-xfs'

master_cpus = (ENV['MASTER_CPUS'] || env_vars['MASTER_CPUS'] || 2).to_i
master_memory = (ENV['MASTER_MEMORY'] || env_vars['MASTER_MEMORY'] || 4096).to_i

worker_cpus = (ENV['WORKER_CPUS'] || env_vars['WORKER_CPUS'] || 4).to_i
worker_memory = (ENV['WORKER_MEMORY'] || env_vars['WORKER_MEMORY'] || 8192).to_i

nodes = [
  { name: 'master-1', ip: "#{subnet}.10", cpus: master_cpus, memory: master_memory, role: 'master' },
  { name: 'worker-1', ip: "#{subnet}.21", cpus: worker_cpus, memory: worker_memory, role: 'worker' },
  { name: 'worker-2', ip: "#{subnet}.22", cpus: worker_cpus, memory: worker_memory, role: 'worker' },
  { name: 'worker-3', ip: "#{subnet}.23", cpus: worker_cpus, memory: worker_memory, role: 'worker' }
]

Vagrant.configure("2") do |config|
  config.vm.box = box_name
  config.vm.boot_timeout = 600

  nodes.each do |node|
    config.vm.define node[:name] do |node_config|
      node_config.vm.hostname = node[:name]
      node_config.vm.network "private_network", ip: node[:ip], netmask: "255.255.255.0", vnet: "vmnet12"

      # Host Port Forwards mapping guest K8s NodePorts to host ports
      if node[:role] == 'master'
        node_config.vm.network "forwarded_port", guest: 30094, host: (env_vars['HOST_PORT_KAFKA'] || 9094).to_i, auto_correct: true
        node_config.vm.network "forwarded_port", guest: 30181, host: (env_vars['HOST_PORT_LAKEKEEPER'] || 8181).to_i, auto_correct: true
        node_config.vm.network "forwarded_port", guest: 30080, host: (env_vars['HOST_PORT_TRINO'] || 8080).to_i, auto_correct: true
        node_config.vm.network "forwarded_port", guest: 30085, host: (env_vars['HOST_PORT_AIRFLOW'] || 8085).to_i, auto_correct: true
        node_config.vm.network "forwarded_port", guest: 30088, host: (env_vars['HOST_PORT_SUPERSET'] || 8088).to_i, auto_correct: true
        node_config.vm.network "forwarded_port", guest: 30081, host: (env_vars['HOST_PORT_FLINK'] || 8081).to_i, auto_correct: true
        node_config.vm.network "forwarded_port", guest: 30333, host: (env_vars['HOST_PORT_SEAWEED_S3'] || 8333).to_i, auto_correct: true
        node_config.vm.network "forwarded_port", guest: 30888, host: (env_vars['HOST_PORT_SEAWEED_FILER'] || 8888).to_i, auto_correct: true
        node_config.vm.network "forwarded_port", guest: 30000, host: (env_vars['HOST_PORT_GRAFANA'] || 3000).to_i, auto_correct: true
        node_config.vm.network "forwarded_port", guest: 30090, host: (env_vars['HOST_PORT_PROMETHEUS'] || 9090).to_i, auto_correct: true
        node_config.vm.network "forwarded_port", guest: 30443, host: (env_vars['HOST_PORT_ARGOCD'] || 8443).to_i, auto_correct: true
      end

      # Provider configuration
      node_config.vm.provider "vmware_fusion" do |v|
        v.vmx["numvcpus"] = node[:cpus]
        v.vmx["memsize"] = node[:memory]
        v.gui = false
      end

      node_config.vm.provider "virtualbox" do |vb|
        vb.cpus = node[:cpus]
        vb.memory = node[:memory]
        vb.gui = false
      end

      node_config.vm.provision "shell", inline: <<-SHELL
        sudo mkdir -p /etc/beluga
        echo "ROLE=#{node[:role]}" | sudo tee /etc/beluga/node.env
        echo "NODE_NAME=#{node[:name]}" | sudo tee -a /etc/beluga/node.env
        echo "NODE_IP=#{node[:ip]}" | sudo tee -a /etc/beluga/node.env
      SHELL
    end
  end
end
