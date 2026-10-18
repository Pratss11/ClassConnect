pipeline {
    agent any
    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }
        stage('Install Backend Dependencies') {
            steps {
                dir('server') {
                    bat 'npm ci'
                }
            }
        }
        stage('Run Backend Tests') {
            steps {
                dir('server') {
                    bat 'npm test'
                }
            }
        }
    }
    post {
        success {
            echo 'ClassConnect CI: all tests passed!'
        }
        failure {
            echo 'ClassConnect CI failed. Check the stage logs.'
        }
    }
}
